import type { DatasetDescriptor, IndexingProgress, IndexingResult, OctreeNode, TileData, WorkerResponse } from '@/features/viewer/data/types'
import type { DeleteBySelectionOp, TileMask } from '@/features/viewer/editor/edit-log'
import type { PointCloudRenderer } from '@/features/viewer/renderer/point-cloud-renderer'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import { Matrix4 } from 'three'
import { readTile } from '@/features/viewer/cache/opfs-cache'
import { ExportDialog } from '@/features/viewer/components/export-dialog'
import { FileOpener } from '@/features/viewer/components/file-opener'
import { ProgressOverlay } from '@/features/viewer/components/progress-overlay'
import { SelectionOverlay } from '@/features/viewer/components/selection-overlay'
import { StatusBar } from '@/features/viewer/components/status-bar'
import { Toolbar } from '@/features/viewer/components/toolbar'
import { ViewerCanvas } from '@/features/viewer/components/viewer-canvas'
import { parseCopc } from '@/features/viewer/data/copc-reader'
import { decodeTileBinary } from '@/features/viewer/data/octree-builder'
import { ExportSession } from '@/features/viewer/editor/export-session'
import { useEditSession } from '@/features/viewer/hooks/use-edit-session'
import { useSelection } from '@/features/viewer/hooks/use-selection'
import { useWorkerPool } from '@/features/viewer/hooks/use-worker-pool'
import { TileScheduler } from '@/features/viewer/scheduler/tile-scheduler'
import { createCameraIdleDetector, extractFrustumPlanes } from '@/features/viewer/scheduler/view-state'
import { useViewerStore } from '@/features/viewer/store'

export const Route = createFileRoute('/viewer')({
  component: ViewerPage,
})

// ---------------------------------------------------------------------------
// Indexing Worker helper — runs LAS/LAZ → octree conversion
// ---------------------------------------------------------------------------

function runIndexingWorker(
  file: File,
  datasetId: string,
  onProgress: (p: IndexingProgress) => void,
): Promise<IndexingResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../features/viewer/workers/indexing.worker.ts', import.meta.url),
      { type: 'module' },
    )
    const requestId = `index-${Date.now()}`

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.requestId !== requestId)
        return

      if (msg.type === 'progress') {
        onProgress(msg.payload as IndexingProgress)
      }
      else if (msg.type === 'result') {
        worker.terminate()
        resolve(msg.payload as IndexingResult)
      }
      else if (msg.type === 'error') {
        worker.terminate()
        reject(new Error((msg.payload as { message: string }).message))
      }
    }

    worker.onerror = (err) => {
      worker.terminate()
      reject(new Error(err.message || 'Indexing worker failed'))
    }

    worker.postMessage({
      requestId,
      type: 'index',
      payload: { file, datasetId } satisfies import('@/features/viewer/data/types').IndexingPayload,
    })
  })
}

function ViewerPage() {
  const rendererRef = useRef<PointCloudRenderer | null>(null)
  const schedulerRef = useRef<TileScheduler | null>(null)
  const idleDetectorRef = useRef<ReturnType<typeof createCameraIdleDetector> | null>(null)
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const exportSessionRef = useRef<ExportSession | null>(null)
  const cancelRef = useRef(false)

  const descriptor = useViewerStore(s => s.descriptor)
  const pointBudget = useViewerStore(s => s.pointBudget)
  const qualityPreset = useViewerStore(s => s.qualityPreset)
  const selectionMap = useViewerStore(s => s.selectionMap)
  const setDataset = useViewerStore(s => s.setDataset)
  const setLoading = useViewerStore(s => s.setLoading)
  const setLoadingProgress = useViewerStore(s => s.setLoadingProgress)
  const setExporting = useViewerStore(s => s.setExporting)
  const updateExportProgress = useViewerStore(s => s.updateExportProgress)
  const updateStats = useViewerStore(s => s.updateStats)
  const clearSelection = useViewerStore(s => s.clearSelection)
  const reset = useViewerStore(s => s.reset)

  const workerPool = useWorkerPool()
  const editSession = useEditSession(descriptor?.id ?? null)
  const selection = useSelection(rendererRef.current)

  // Clean up on unmount
  useEffect(() => {
    return () => {
      schedulerRef.current?.dispose()
      idleDetectorRef.current?.dispose()
      if (statsIntervalRef.current)
        clearInterval(statsIntervalRef.current)
      exportSessionRef.current?.cancel()
      reset()
    }
  }, [reset])

  // Apply selection masks to renderer
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer)
      return
    renderer.updateSelection(selectionMap)
  }, [selectionMap])

  const buildViewState = useCallback(() => {
    const renderer = rendererRef.current
    if (!renderer)
      return null

    const { camera } = renderer
    camera.updateMatrixWorld()
    const vp = new Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    )

    return {
      frustumPlanes: extractFrustumPlanes(vp.elements),
      cameraPosition: [
        camera.position.x,
        camera.position.y,
        camera.position.z,
      ] as readonly [number, number, number],
      screenHeight: window.innerHeight,
      fov: (camera.fov * Math.PI) / 180,
    }
  }, [])

  const triggerSchedulerUpdate = useCallback(() => {
    const scheduler = schedulerRef.current
    if (!scheduler)
      return
    const view = buildViewState()
    if (view)
      scheduler.update(view)
  }, [buildViewState])

  const handleRendererReady = useCallback((renderer: PointCloudRenderer) => {
    rendererRef.current = renderer
  }, [])

  const handleRendererDispose = useCallback(() => {
    rendererRef.current = null
    schedulerRef.current?.dispose()
    schedulerRef.current = null
    idleDetectorRef.current?.dispose()
    idleDetectorRef.current = null
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current)
      statsIntervalRef.current = null
    }
  }, [])

  const handleCancel = useCallback(() => {
    cancelRef.current = true
    setLoading(false)
  }, [setLoading])

  const setupScheduler = useCallback((
    hierarchy: Map<string, import('@/features/viewer/data/types').OctreeNode>,
    desc: DatasetDescriptor,
    sourceFile: File,
    pointRecordLength: number,
  ) => {
    const renderer = rendererRef.current
    if (!renderer)
      return

    const scheduler = new TileScheduler(
      hierarchy,
      workerPool.decode,
      {
        onTileLoaded: (nodeId, data) => renderer.addTile(nodeId, data),
        onTileEvicted: nodeId => renderer.removeTile(nodeId),
      },
      {
        file: sourceFile,
        pointFormat: desc.pointFormat,
        pointRecordLength,
        scale: desc.scale,
        offset: desc.offset,
      },
      { pointBudget },
    )
    scheduler.setQuality(qualityPreset)
    schedulerRef.current = scheduler

    // Center camera on dataset bounds
    const { bounds } = desc
    const cx = (bounds.min[0] + bounds.max[0]) / 2
    const cy = (bounds.min[1] + bounds.max[1]) / 2
    const cz = (bounds.min[2] + bounds.max[2]) / 2
    const dx = bounds.max[0] - bounds.min[0]
    const dy = bounds.max[1] - bounds.min[1]
    const dz = bounds.max[2] - bounds.min[2]
    const size = Math.max(dx, dy, dz)

    renderer.controls.target.set(cx, cy, cz)
    renderer.camera.position.set(cx, cy + size * 0.5, cz + size)
    renderer.camera.lookAt(cx, cy, cz)
    renderer.controls.update()
    renderer.updateHeightRange(bounds.min[1], bounds.max[1])

    // Initial scheduling pass
    const view = buildViewState()
    if (view)
      scheduler.update(view)

    // Camera idle detection for re-scheduling
    const detector = createCameraIdleDetector(() => {
      triggerSchedulerUpdate()
    }, 150)
    idleDetectorRef.current = detector
    renderer.controls.addEventListener('change', detector.onCameraMove)

    // Poll stats
    statsIntervalRef.current = setInterval(() => {
      const s = schedulerRef.current
      const r = rendererRef.current
      if (s && r) {
        updateStats({
          loadedPointCount: s.loadedPointCount,
          activeTileCount: s.activeTileCount,
          fps: r.fps,
        })
      }
    }, 500)
  }, [workerPool.decode, pointBudget, qualityPreset, buildViewState, triggerSchedulerUpdate, updateStats])

  const setupSchedulerWithDecode = useCallback((
    hierarchy: Map<string, OctreeNode>,
    desc: DatasetDescriptor,
    sourceFile: File,
    pointRecordLength: number,
    decode: (payload: import('@/features/viewer/data/types').DecodeTilePayload) => Promise<TileData>,
  ) => {
    const renderer = rendererRef.current
    if (!renderer)
      return

    const scheduler = new TileScheduler(
      hierarchy,
      decode,
      {
        onTileLoaded: (nodeId, data) => renderer.addTile(nodeId, data),
        onTileEvicted: nodeId => renderer.removeTile(nodeId),
      },
      {
        file: sourceFile,
        pointFormat: desc.pointFormat,
        pointRecordLength,
        scale: desc.scale,
        offset: desc.offset,
      },
      { pointBudget },
    )
    scheduler.setQuality(qualityPreset)
    schedulerRef.current = scheduler

    const { bounds } = desc
    const cx = (bounds.min[0] + bounds.max[0]) / 2
    const cy = (bounds.min[1] + bounds.max[1]) / 2
    const cz = (bounds.min[2] + bounds.max[2]) / 2
    const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2])

    renderer.controls.target.set(cx, cy, cz)
    renderer.camera.position.set(cx, cy + size * 0.5, cz + size)
    renderer.camera.lookAt(cx, cy, cz)
    renderer.controls.update()
    renderer.updateHeightRange(bounds.min[1], bounds.max[1])

    const view = buildViewState()
    if (view)
      scheduler.update(view)

    const detector = createCameraIdleDetector(() => triggerSchedulerUpdate(), 150)
    idleDetectorRef.current = detector
    renderer.controls.addEventListener('change', detector.onCameraMove)

    statsIntervalRef.current = setInterval(() => {
      const s = schedulerRef.current
      const r = rendererRef.current
      if (s && r) {
        updateStats({
          loadedPointCount: s.loadedPointCount,
          activeTileCount: s.activeTileCount,
          fps: r.fps,
        })
      }
    }, 500)
  }, [pointBudget, qualityPreset, buildViewState, triggerSchedulerUpdate, updateStats])

  const handleFileLoaded = useCallback(async (desc: DatasetDescriptor, sourceFile: File) => {
    const renderer = rendererRef.current
    if (!renderer)
      return

    cancelRef.current = false
    setDataset(desc, sourceFile)

    try {
      if (desc.sourceFormat === 'copc') {
        // COPC path — parse hierarchy directly
        setLoading(true, 'Reading header...')
        const { hierarchy } = await parseCopc(sourceFile, (phase, percent) => {
          if (cancelRef.current)
            return
          setLoading(true, phase === 'header' ? 'Reading header...' : 'Loading hierarchy...')
          setLoadingProgress(percent)
        })
        if (cancelRef.current)
          return
        setLoading(false)

        const headerBuf = await sourceFile.slice(105, 107).arrayBuffer()
        const pointRecordLength = new DataView(headerBuf).getUint16(0, true)
        setupScheduler(hierarchy, desc, sourceFile, pointRecordLength)
      }
      else {
        // LAS/LAZ path — index via Worker, then load from OPFS cache
        setLoading(true, 'Indexing point cloud...')
        const { hierarchy: hierArr, descriptor: indexedDesc } = await runIndexingWorker(
          sourceFile,
          desc.id,
          (progress) => {
            if (cancelRef.current)
              return
            setLoading(true, `${progress.phase} (${Math.round(progress.pointsProcessed / Math.max(progress.totalPoints, 1) * 100)}%)`)
            setLoadingProgress(progress.pointsProcessed / Math.max(progress.totalPoints, 1) * 100)
          },
        )
        if (cancelRef.current)
          return
        setLoading(false)

        // Build hierarchy map
        const hierarchy = new Map<string, OctreeNode>()
        for (const node of hierArr) {
          hierarchy.set(node.id, node)
        }

        // Create OPFS-based decode dispatcher
        const datasetId = desc.id
        const opfsDecode = async (payload: import('@/features/viewer/data/types').DecodeTilePayload): Promise<TileData> => {
          const buf = await readTile(datasetId, payload.nodeId)
          if (!buf)
            throw new Error(`Tile ${payload.nodeId} not found in cache`)
          const decoded = decodeTileBinary(buf)
          return {
            nodeId: payload.nodeId,
            level: payload.level,
            pointCount: decoded.pointCount,
            bounds: payload.bounds,
            spacing: payload.nodeId === '0-0-0-0' ? undefined : undefined,
            positions: decoded.positions,
            colors: decoded.colors,
            intensity: decoded.intensity,
            classification: decoded.classification,
          }
        }

        // Use indexed descriptor if available
        const finalDesc = indexedDesc ?? desc
        const headerBuf = await sourceFile.slice(105, 107).arrayBuffer()
        const pointRecordLength = new DataView(headerBuf).getUint16(0, true)
        setupSchedulerWithDecode(hierarchy, finalDesc, sourceFile, pointRecordLength, opfsDecode)
      }
    }
    catch (err) {
      if (!cancelRef.current) {
        setLoading(false)

        console.error('File loading failed:', err)
      }
    }
  }, [setDataset, setLoading, setLoadingProgress, setupScheduler, setupSchedulerWithDecode])

  // --- Selection actions: Delete / Keep ---

  const handleDeleteSelected = useCallback(() => {
    const sm = useViewerStore.getState().selectionMap
    if (sm.size === 0)
      return
    const masks: TileMask[] = []
    for (const [tileId, mask] of sm) {
      masks.push({ tileId, mask })
    }
    const op: DeleteBySelectionOp = { type: 'deleteBySelection', masks }
    const renderer = rendererRef.current
    const cam = renderer?.camera
    const ctrl = renderer?.controls
    editSession.apply(op, cam && ctrl
      ? {
          position: [cam.position.x, cam.position.y, cam.position.z],
          target: [ctrl.target.x, ctrl.target.y, ctrl.target.z],
        }
      : null)

    // Visual feedback: hide deleted points by zeroing their positions in the GPU buffer
    if (renderer) {
      for (const [tileId, mask] of sm) {
        renderer.applyDeletionMask(tileId, mask)
      }
    }
    clearSelection()
  }, [editSession, clearSelection])

  const handleKeepSelected = useCallback(() => {
    const sm = useViewerStore.getState().selectionMap
    if (sm.size === 0)
      return
    const masks: TileMask[] = []
    for (const [tileId, mask] of sm) {
      const inverted = new Uint8Array(mask.length)
      for (let i = 0; i < mask.length; i++) {
        inverted[i] = mask[i] === 1 ? 0 : 1
      }
      masks.push({ tileId, mask: inverted })
    }
    const op: DeleteBySelectionOp = { type: 'deleteBySelection', masks }
    editSession.apply(op)

    // Visual feedback: hide non-selected (inverted mask = deleted) points
    const renderer = rendererRef.current
    if (renderer) {
      for (const { tileId, mask } of masks) {
        renderer.applyDeletionMask(tileId, mask)
      }
    }
    clearSelection()
  }, [editSession, clearSelection])

  // --- Export ---

  const handleExport = useCallback(() => {
    const state = useViewerStore.getState()
    if (!state.descriptor || !state.file)
      return

    setExporting(true)
    const session = new ExportSession()
    exportSessionRef.current = session

    session.start({
      file: state.file,
      descriptor: state.descriptor,
      editLog: editSession.activeEntries.map((e) => {
        const op = e.operation
        // Convert edit-log.ts EditOperation → export-session EditLogEntry
        // deleteBySelection: TileMask[] → Record<string, Set<number>>
        // Other ops: pass params through (export worker handles runtime shape)
        if (op.type === 'deleteBySelection') {
          const masks: Record<string, Set<number>> = {}
          for (const tm of op.masks) {
            const indices = new Set<number>()
            for (let i = 0; i < tm.mask.length; i++) {
              if (tm.mask[i] === 1)
                indices.add(i)
            }
            masks[tm.tileId] = indices
          }
          return { type: op.type, params: { masks }, timestamp: e.timestamp }
        }
        // For keepByAABB, filterByClassification, filterByRange: export worker reads
        // params by field name at runtime, so pass the operation object directly
        return { type: op.type, params: op, timestamp: e.timestamp }
      }) as unknown as import('@/features/viewer/editor/edit-log-types').EditLogEntry[],
      onProgress: (p) => {
        updateExportProgress({
          phase: p.phase,
          pointsProcessed: p.pointsProcessed,
          totalPoints: p.totalPoints,
          bytesWritten: p.bytesWritten,
        })
      },
      onComplete: () => {
        setExporting(false)
        exportSessionRef.current = null
      },
      onError: () => {
        setExporting(false)
        exportSessionRef.current = null
      },
    })
  }, [setExporting, updateExportProgress])

  const handleExportCancel = useCallback(() => {
    exportSessionRef.current?.cancel()
    exportSessionRef.current = null
    setExporting(false)
  }, [setExporting])

  // Sync budget/preset changes to scheduler at runtime
  useEffect(() => {
    const scheduler = schedulerRef.current
    if (!scheduler)
      return
    scheduler.setConfig({ pointBudget })
    triggerSchedulerUpdate()
  }, [pointBudget, triggerSchedulerUpdate])

  useEffect(() => {
    const scheduler = schedulerRef.current
    if (!scheduler)
      return
    scheduler.setQuality(qualityPreset)
    triggerSchedulerUpdate()
  }, [qualityPreset, triggerSchedulerUpdate])

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-neutral-900">
      {/* 3D Canvas with selection pointer events */}
      <div
        className="h-full w-full"
        onPointerDown={selection.onPointerDown}
        onPointerMove={selection.onPointerMove}
        onPointerUp={selection.onPointerUp}
      >
        <ViewerCanvas
          onRendererReady={handleRendererReady}
          onRendererDispose={handleRendererDispose}
        />
      </div>

      {/* Selection rubber-band overlay */}
      {selection.dragRect && <SelectionOverlay rect={selection.dragRect} />}

      {/* File opener — shown when no dataset loaded */}
      {!descriptor && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/90">
          <FileOpener onFileLoaded={handleFileLoaded} />
        </div>
      )}

      {/* Progress overlay */}
      <ProgressOverlay onCancel={handleCancel} />

      {/* Export dialog */}
      <ExportDialog onCancel={handleExportCancel} />

      {/* Top toolbar */}
      {descriptor && (
        <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2">
          <Toolbar
            onExport={handleExport}
            onDeleteSelected={handleDeleteSelected}
            onKeepSelected={handleKeepSelected}
          />
        </div>
      )}

      {/* Bottom status bar */}
      {descriptor && (
        <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
          <StatusBar />
        </div>
      )}
    </div>
  )
}
