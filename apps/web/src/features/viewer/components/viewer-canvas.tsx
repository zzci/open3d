import { useEffect, useRef } from 'react'
import { useSelection } from '../hooks/use-selection'
import { PointCloudRenderer } from '../renderer/point-cloud-renderer'
import { useViewerStore } from '../store'
import { SelectionOverlay } from './selection-overlay'

interface ViewerCanvasProps {
  onRendererReady: (renderer: PointCloudRenderer) => void
  onRendererDispose?: () => void
}

export function ViewerCanvas({ onRendererReady, onRendererDispose }: ViewerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<PointCloudRenderer | null>(null)
  const colorMode = useViewerStore(s => s.colorMode)
  const pointSize = useViewerStore(s => s.pointSize)
  const edlEnabled = useViewerStore(s => s.edlEnabled)
  const edlRadius = useViewerStore(s => s.edlRadius)
  const edlStrength = useViewerStore(s => s.edlStrength)
  const edlExponent = useViewerStore(s => s.edlExponent)
  const selectionMap = useViewerStore(s => s.selectionMap)
  const selectionMode = useViewerStore(s => s.selectionMode)

  // Mount renderer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas)
      return

    const renderer = new PointCloudRenderer(canvas, { colorMode, pointSize })
    rendererRef.current = renderer
    onRendererReady(renderer)

    return () => {
      rendererRef.current = null
      renderer.dispose()
      onRendererDispose?.()
    }
    // Only mount/unmount on canvas — settings are synced separately
    // eslint-disable-next-line react/exhaustive-deps
  }, [])

  // Sync color mode
  useEffect(() => {
    rendererRef.current?.updateColorMode(colorMode)
  }, [colorMode])

  // Sync point size
  useEffect(() => {
    rendererRef.current?.updatePointSize(pointSize)
  }, [pointSize])

  // Sync EDL enabled
  useEffect(() => {
    rendererRef.current?.updateEdlEnabled(edlEnabled)
  }, [edlEnabled])

  // Sync EDL parameters
  useEffect(() => {
    rendererRef.current?.updateEdlParams({
      radius: edlRadius,
      strength: edlStrength,
      exponent: edlExponent,
    })
  }, [edlRadius, edlStrength, edlExponent])

  // Sync selection highlight to renderer
  useEffect(() => {
    rendererRef.current?.updateSelection(selectionMap)
  }, [selectionMap])

  // Selection hook
  const { dragRect, onPointerDown, onPointerMove, onPointerUp } = useSelection(rendererRef.current)

  return (
    <div
      className="absolute inset-0"
      style={{ cursor: selectionMode ? 'crosshair' : 'default' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
      />
      <SelectionOverlay rect={dragRect} />
    </div>
  )
}
