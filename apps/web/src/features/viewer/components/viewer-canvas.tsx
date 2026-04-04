import { useEffect, useRef } from 'react'
import { useSelection } from '../hooks/use-selection'
import { PointCloudRenderer } from '../renderer/point-cloud-renderer'
import { RENDER_MODES } from '../renderer/render-modes'
import { useViewerStore } from '../store'
import { SelectionOverlay } from './selection-overlay'

interface ViewerCanvasProps {
  onRendererReady: (renderer: PointCloudRenderer) => void
  onRendererDispose?: () => void
}

export function ViewerCanvas({ onRendererReady, onRendererDispose }: ViewerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<PointCloudRenderer | null>(null)
  const renderMode = useViewerStore(s => s.renderMode)
  const colorMode = useViewerStore(s => s.colorMode)
  const paletteId = useViewerStore(s => s.paletteId)
  const sizeMultiplier = useViewerStore(s => s.sizeMultiplier)
  const selectionMap = useViewerStore(s => s.selectionMap)
  const selectionMode = useViewerStore(s => s.selectionMode)
  const dpiScale = useViewerStore(s => s.dpiScale)
  const intensityNormMode = useViewerStore(s => s.intensityNormMode)
  const edlEnabled = useViewerStore(s => s.edlEnabled)
  const edlRadius = useViewerStore(s => s.edlRadius)
  const edlStrength = useViewerStore(s => s.edlStrength)
  const edlExponent = useViewerStore(s => s.edlExponent)

  // Mount renderer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas)
      return

    const renderer = new PointCloudRenderer(canvas, {
      colorMode,
      sizeMultiplier,
      dpiScale,
    })

    // Wire auto-downscale notification into the store
    renderer.setAutoDownscaleCallback(() => {
      useViewerStore.getState().setDpiAutoDownscaled(true)
    })

    // Apply initial render mode settings
    renderer.applyRenderMode(RENDER_MODES[renderMode])

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

  // Sync render mode
  useEffect(() => {
    rendererRef.current?.applyRenderMode(RENDER_MODES[renderMode])
  }, [renderMode])

  // Sync color mode
  useEffect(() => {
    rendererRef.current?.updateColorMode(colorMode)
  }, [colorMode])

  // Sync palette
  useEffect(() => {
    rendererRef.current?.updatePalette(paletteId)
  }, [paletteId])

  // Sync size multiplier
  useEffect(() => {
    rendererRef.current?.updateSizeMultiplier(sizeMultiplier)
  }, [sizeMultiplier])

  // Sync selection highlight to renderer
  useEffect(() => {
    rendererRef.current?.updateSelection(selectionMap)
  }, [selectionMap])

  // Sync intensity normalization mode
  useEffect(() => {
    rendererRef.current?.updateIntensityNormMode(intensityNormMode)
  }, [intensityNormMode])

  // Sync DPI scale
  useEffect(() => {
    rendererRef.current?.updateDpiScale(dpiScale)
  }, [dpiScale])

  // Sync EDL settings
  useEffect(() => {
    rendererRef.current?.updateEdlEnabled(edlEnabled)
  }, [edlEnabled])

  useEffect(() => {
    rendererRef.current?.updateEdlParams({
      radius: edlRadius,
      strength: edlStrength,
      exponent: edlExponent,
    })
  }, [edlRadius, edlStrength, edlExponent])

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
