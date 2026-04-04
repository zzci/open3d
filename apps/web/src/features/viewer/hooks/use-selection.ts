import type { SelectionRect } from '../components/selection-overlay'
import type { PointCloudRenderer } from '../renderer/point-cloud-renderer'
import type { SelectionPayload, SelectionRequest, SelectionResponse, SelectionTileInput } from '../workers/selection.worker'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Matrix4 } from 'three'
import { useViewerStore } from '../store'

// ---------------------------------------------------------------------------
// useSelection — orchestrates the full selection pipeline
//
// 1. Mouse drag → rubber-band rect
// 2. On release → coarse filter (tile AABB vs selection frustum)
// 3. Fine filter via Selection Worker (per-point projection test)
// 4. Store results in Zustand
// ---------------------------------------------------------------------------

export function useSelection(renderer: PointCloudRenderer | null) {
  const selectionMode = useViewerStore(s => s.selectionMode)
  const setSelection = useViewerStore(s => s.setSelection)

  const [dragRect, setDragRect] = useState<SelectionRect | null>(null)
  const dragStartRef = useRef<{ x: number, y: number } | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const pendingResolveRef = useRef<Map<string, (resp: SelectionResponse) => void>>(new Map())

  // Create/dispose worker
  useEffect(() => {
    const pending = pendingResolveRef.current
    const worker = new Worker(
      new URL('../workers/selection.worker.ts', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = (e: MessageEvent<SelectionResponse>) => {
      const resolve = pending.get(e.data.requestId)
      if (resolve) {
        pending.delete(e.data.requestId)
        resolve(e.data)
      }
    }
    workerRef.current = worker
    return () => {
      worker.terminate()
      workerRef.current = null
      pending.clear()
    }
  }, [])

  // Disable orbit controls when in selection mode
  useEffect(() => {
    if (!renderer)
      return
    renderer.controls.enabled = !selectionMode
  }, [renderer, selectionMode])

  const sendToWorker = useCallback((payload: SelectionPayload): Promise<SelectionResponse> => {
    const worker = workerRef.current
    if (!worker)
      return Promise.reject(new Error('Selection worker not initialized'))

    const requestId = crypto.randomUUID()
    return new Promise((resolve) => {
      const pending = pendingResolveRef.current
      pending.set(requestId, resolve)

      // Timeout: clean up if worker doesn't respond in 30s
      const timer = setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId)
          resolve({ requestId, type: 'error', payload: 'Selection timed out' } as SelectionResponse)
        }
      }, 30_000)

      const originalResolve = resolve
      pending.set(requestId, (resp) => {
        clearTimeout(timer)
        pending.delete(requestId)
        originalResolve(resp)
      })

      const msg: SelectionRequest = { requestId, type: 'select', payload }
      const transferables: Transferable[] = payload.tiles.map(t => t.positions.buffer as ArrayBuffer)
      worker.postMessage(msg, transferables)
    })
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!selectionMode)
      return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    dragStartRef.current = { x, y }
    setDragRect(null)
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [selectionMode])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!selectionMode || !dragStartRef.current)
      return
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const { x: sx, y: sy } = dragStartRef.current
    setDragRect({
      x: Math.min(sx, cx),
      y: Math.min(sy, cy),
      width: Math.abs(cx - sx),
      height: Math.abs(cy - sy),
    })
  }, [selectionMode])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!selectionMode || !dragStartRef.current || !renderer) {
      dragStartRef.current = null
      setDragRect(null)
      return
    }

    const containerRect = e.currentTarget.getBoundingClientRect()
    const endX = e.clientX - containerRect.left
    const endY = e.clientY - containerRect.top
    const { x: startX, y: startY } = dragStartRef.current
    dragStartRef.current = null
    setDragRect(null)

    // Ignore tiny drags (likely misclicks)
    if (Math.abs(endX - startX) < 3 || Math.abs(endY - startY) < 3)
      return

    const screenRect: [number, number, number, number] = [startX, startY, endX, endY]
    const vw = containerRect.width
    const vh = containerRect.height

    runSelectionPipeline(renderer, screenRect, vw, vh, sendToWorker, setSelection)
  }, [selectionMode, renderer, sendToWorker, setSelection])

  return {
    dragRect,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}

// ---------------------------------------------------------------------------
// Selection pipeline: coarse AABB filter → fine per-point worker test
// ---------------------------------------------------------------------------

async function runSelectionPipeline(
  renderer: PointCloudRenderer,
  screenRect: [number, number, number, number],
  viewportWidth: number,
  viewportHeight: number,
  sendToWorker: (payload: SelectionPayload) => Promise<SelectionResponse>,
  setSelection: (map: Map<string, Uint8Array>) => void,
) {
  const { camera } = renderer

  // Build MVP matrix
  camera.updateMatrixWorld()
  const mvp = new Matrix4()
  mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const mvpArray = new Float64Array(mvp.elements)

  // Normalize screen rect for AABB coarse test
  const [sx0, sy0, sx1, sy1] = screenRect
  const ndcX0 = (Math.min(sx0, sx1) / viewportWidth) * 2 - 1
  const ndcX1 = (Math.max(sx0, sx1) / viewportWidth) * 2 - 1
  const ndcY0 = 1 - (Math.max(sy0, sy1) / viewportHeight) * 2
  const ndcY1 = 1 - (Math.min(sy0, sy1) / viewportHeight) * 2

  // Coarse filter: project each tile AABB corners → check overlap with selection rect
  const candidateTiles: SelectionTileInput[] = []
  const tiles = renderer.getTiles()

  for (const [nodeId, tileMesh] of tiles) {
    const posAttr = tileMesh.points.geometry.getAttribute('position')
    if (!posAttr)
      continue

    // Quick AABB test: project AABB corners to NDC, check overlap
    const bb = tileMesh.points.geometry.boundingBox
      ?? tileMesh.points.geometry.computeBoundingBox()
      ?? tileMesh.points.geometry.boundingBox

    if (!bb)
      continue

    // Project all 8 corners, find min/max NDC
    const corners = [
      [bb.min.x, bb.min.y, bb.min.z],
      [bb.max.x, bb.min.y, bb.min.z],
      [bb.min.x, bb.max.y, bb.min.z],
      [bb.max.x, bb.max.y, bb.min.z],
      [bb.min.x, bb.min.y, bb.max.z],
      [bb.max.x, bb.min.y, bb.max.z],
      [bb.min.x, bb.max.y, bb.max.z],
      [bb.max.x, bb.max.y, bb.max.z],
    ] as const

    let projMinX = Infinity
    let projMaxX = -Infinity
    let projMinY = Infinity
    let projMaxY = -Infinity
    let anyInFront = false

    for (const [cx, cy, cz] of corners) {
      const cw = mvpArray[3]! * cx + mvpArray[7]! * cy + mvpArray[11]! * cz + mvpArray[15]!
      if (cw <= 0)
        continue
      anyInFront = true
      const nx = (mvpArray[0]! * cx + mvpArray[4]! * cy + mvpArray[8]! * cz + mvpArray[12]!) / cw
      const ny = (mvpArray[1]! * cx + mvpArray[5]! * cy + mvpArray[9]! * cz + mvpArray[13]!) / cw
      if (nx < projMinX)
        projMinX = nx
      if (nx > projMaxX)
        projMaxX = nx
      if (ny < projMinY)
        projMinY = ny
      if (ny > projMaxY)
        projMaxY = ny
    }

    if (!anyInFront)
      continue

    // AABB overlap test in NDC
    if (projMaxX < ndcX0 || projMinX > ndcX1 || projMaxY < ndcY0 || projMinY > ndcY1) {
      continue
    }

    // Copy positions for transfer to worker
    const srcArray = posAttr.array as Float32Array
    const positions = new Float32Array(srcArray.length)
    positions.set(srcArray)

    candidateTiles.push({
      nodeId,
      positions,
      pointCount: posAttr.count,
    })
  }

  if (candidateTiles.length === 0) {
    setSelection(new Map())
    return
  }

  // Fine filter via worker
  const payload: SelectionPayload = {
    mvpMatrix: mvpArray,
    screenRect,
    viewportWidth,
    viewportHeight,
    tiles: candidateTiles,
  }

  const response = await sendToWorker(payload)

  if (response.type === 'error') {
    return
  }

  const resultPayload = response.payload as { tiles: Array<{ nodeId: string, mask: Uint8Array }> }
  const selectionMap = new Map<string, Uint8Array>()
  for (const tile of resultPayload.tiles) {
    // Only store tiles with at least one selected point
    let hasSelected = false
    for (let i = 0; i < tile.mask.length; i++) {
      if (tile.mask[i] === 1) {
        hasSelected = true
        break
      }
    }
    if (hasSelected) {
      selectionMap.set(tile.nodeId, tile.mask)
    }
  }

  setSelection(selectionMap)
}
