import type { DatasetDescriptor } from '@/features/viewer/data/types'
import type { PointCloudRenderer } from '@/features/viewer/renderer/point-cloud-renderer'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import { Matrix4 } from 'three'
import { FileOpener } from '@/features/viewer/components/file-opener'
import { ProgressOverlay } from '@/features/viewer/components/progress-overlay'
import { StatusBar } from '@/features/viewer/components/status-bar'
import { Toolbar } from '@/features/viewer/components/toolbar'
import { ViewerCanvas } from '@/features/viewer/components/viewer-canvas'
import { parseCopc } from '@/features/viewer/data/copc-reader'
import { useWorkerPool } from '@/features/viewer/hooks/use-worker-pool'
import { TileScheduler } from '@/features/viewer/scheduler/tile-scheduler'
import { createCameraIdleDetector, extractFrustumPlanes } from '@/features/viewer/scheduler/view-state'
import { useViewerStore } from '@/features/viewer/store'

export const Route = createFileRoute('/viewer')({
  component: ViewerPage,
})

function ViewerPage() {
  const rendererRef = useRef<PointCloudRenderer | null>(null)
  const schedulerRef = useRef<TileScheduler | null>(null)
  const idleDetectorRef = useRef<ReturnType<typeof createCameraIdleDetector> | null>(null)
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelRef = useRef(false)

  const descriptor = useViewerStore(s => s.descriptor)
  const pointBudget = useViewerStore(s => s.pointBudget)
  const qualityPreset = useViewerStore(s => s.qualityPreset)
  const setDataset = useViewerStore(s => s.setDataset)
  const setLoading = useViewerStore(s => s.setLoading)
  const setLoadingProgress = useViewerStore(s => s.setLoadingProgress)
  const updateStats = useViewerStore(s => s.updateStats)
  const reset = useViewerStore(s => s.reset)

  const workerPool = useWorkerPool()

  // Clean up on unmount
  useEffect(() => {
    return () => {
      schedulerRef.current?.dispose()
      idleDetectorRef.current?.dispose()
      if (statsIntervalRef.current)
        clearInterval(statsIntervalRef.current)
      reset()
    }
  }, [reset])

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

  const handleFileLoaded = useCallback(async (desc: DatasetDescriptor, file: File) => {
    const renderer = rendererRef.current
    if (!renderer)
      return

    cancelRef.current = false
    setDataset(desc, file)
    setLoading(true, 'Reading header...')

    try {
      const { hierarchy } = await parseCopc(file, (phase, percent) => {
        if (cancelRef.current)
          return
        setLoading(true, phase === 'header' ? 'Reading header...' : 'Loading hierarchy...')
        setLoadingProgress(percent)
      })

      if (cancelRef.current)
        return
      setLoading(false)

      // Read pointRecordLength from the LAS header (bytes 105-107)
      const headerBuf = await file.slice(105, 107).arrayBuffer()
      const pointRecordLength = new DataView(headerBuf).getUint16(0, true)

      const scheduler = new TileScheduler(
        hierarchy,
        workerPool.decode,
        {
          onTileLoaded: (nodeId, data) => renderer.addTile(nodeId, data),
          onTileEvicted: nodeId => renderer.removeTile(nodeId),
        },
        {
          file,
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

      // Update height range for height color mode
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
    }
    catch {
      if (!cancelRef.current) {
        setLoading(false)
      }
    }
  }, [setDataset, setLoading, setLoadingProgress, workerPool.decode, pointBudget, qualityPreset, buildViewState, triggerSchedulerUpdate, updateStats])

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
      {/* 3D Canvas */}
      <ViewerCanvas
        onRendererReady={handleRendererReady}
        onRendererDispose={handleRendererDispose}
      />

      {/* File opener — shown when no dataset loaded */}
      {!descriptor && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/90">
          <FileOpener onFileLoaded={handleFileLoaded} />
        </div>
      )}

      {/* Progress overlay */}
      <ProgressOverlay onCancel={handleCancel} />

      {/* Top toolbar */}
      {descriptor && (
        <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2">
          <Toolbar />
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
