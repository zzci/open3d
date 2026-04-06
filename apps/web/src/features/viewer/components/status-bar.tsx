import { formatPointCount } from '../lib/format'
import { useViewerStore } from '../store'

export function StatusBar() {
  const loadedPointCount = useViewerStore(s => s.loadedPointCount)
  const activeTileCount = useViewerStore(s => s.activeTileCount)
  const fps = useViewerStore(s => s.fps)
  const datasetInfo = useViewerStore(s => s.datasetInfo)
  const selectedPointCount = useViewerStore(s => s.selectedPointCount)
  const dpiScale = useViewerStore(s => s.dpiScale)
  const dpiAutoDownscaled = useViewerStore(s => s.dpiAutoDownscaled)

  const dpiLabel = dpiScale === 'auto'
    ? `Auto (${Math.min(window.devicePixelRatio, 2).toFixed(1)}x)`
    : `${dpiScale}x`

  return (
    <div className="flex items-center gap-4 rounded-md bg-background/80 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
      {datasetInfo && (
        <>
          <span title={datasetInfo.fileName} className="max-w-[200px] truncate">
            {datasetInfo.fileName}
          </span>
          <span className="uppercase">{datasetInfo.sourceFormat}</span>
          <span>
            {formatPointCount(datasetInfo.totalPoints)}
            {' '}
            total
          </span>
          <div className="h-3 w-px bg-border" />
        </>
      )}

      <span>
        {formatPointCount(loadedPointCount)}
        {' '}
        loaded
      </span>
      <span>
        {activeTileCount}
        {' '}
        tiles
      </span>
      {selectedPointCount > 0 && (
        <span className="text-yellow-400">
          {formatPointCount(selectedPointCount)}
          {' '}
          selected
        </span>
      )}
      <span className="tabular-nums">
        {Math.round(fps)}
        {' '}
        FPS
      </span>
      <span className="tabular-nums">
        DPI
        {' '}
        {dpiAutoDownscaled ? '1x' : dpiLabel}
      </span>
      {dpiAutoDownscaled && (
        <span className="text-amber-400">
          downscaled (low FPS)
        </span>
      )}
    </div>
  )
}
