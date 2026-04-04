import { useEffect, useRef } from 'react'
import { PointCloudRenderer } from '../renderer/point-cloud-renderer'
import { useViewerStore } from '../store'

interface ViewerCanvasProps {
  onRendererReady: (renderer: PointCloudRenderer) => void
  onRendererDispose?: () => void
}

export function ViewerCanvas({ onRendererReady, onRendererDispose }: ViewerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<PointCloudRenderer | null>(null)
  const colorMode = useViewerStore(s => s.colorMode)
  const pointSize = useViewerStore(s => s.pointSize)

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

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
    />
  )
}
