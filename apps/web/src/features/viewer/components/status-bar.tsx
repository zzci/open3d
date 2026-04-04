import { formatPointCount } from '../lib/format'
import { useViewerStore } from '../store'

export function StatusBar() {
  const loadedPointCount = useViewerStore(s => s.loadedPointCount)
  const activeTileCount = useViewerStore(s => s.activeTileCount)
  const fps = useViewerStore(s => s.fps)
  const datasetInfo = useViewerStore(s => s.datasetInfo)

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
      <span className="tabular-nums">
        {Math.round(fps)}
        {' '}
        FPS
      </span>
    </div>
  )
}
