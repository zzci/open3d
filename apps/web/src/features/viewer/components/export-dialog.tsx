import { Button } from '@/shared/components/ui/button'
import { formatPointCount } from '../lib/format'
import { useViewerStore } from '../store'

const PHASE_LABELS: Record<string, string> = {
  counting: 'Counting points…',
  writing: 'Writing LAS file…',
  finalizing: 'Finalizing…',
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576)
    return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024)
    return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

interface ExportDialogProps {
  onCancel: () => void
}

export function ExportDialog({ onCancel }: ExportDialogProps) {
  const isExporting = useViewerStore(s => s.isExporting)
  const progress = useViewerStore(s => s.exportProgress)
  const phase = useViewerStore(s => s.exportPhase)
  const pointsProcessed = useViewerStore(s => s.exportPointsProcessed)
  const totalPoints = useViewerStore(s => s.exportTotalPoints)
  const bytesWritten = useViewerStore(s => s.exportBytesWritten)

  if (!isExporting)
    return null

  const phaseText = PHASE_LABELS[phase] ?? 'Preparing…'

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
      <div className="flex w-80 flex-col items-center gap-4 rounded-lg border bg-background p-6 shadow-lg">
        <div className="text-sm font-medium">Export LAS</div>

        <div className="text-xs text-muted-foreground">{phaseText}</div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>

        <div className="flex w-full justify-between text-xs tabular-nums text-muted-foreground">
          <span>
            {formatPointCount(pointsProcessed)}
            {' / '}
            {formatPointCount(totalPoints)}
            {' pts'}
          </span>
          <span>{formatBytes(bytesWritten)}</span>
        </div>

        <div className="text-xs tabular-nums text-muted-foreground">
          {Math.round(progress)}
          %
        </div>

        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
