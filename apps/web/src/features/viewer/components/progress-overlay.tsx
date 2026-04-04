import { Button } from '@/shared/components/ui/button'
import { useViewerStore } from '../store'

interface ProgressOverlayProps {
  onCancel: () => void
}

export function ProgressOverlay({ onCancel }: ProgressOverlayProps) {
  const isLoading = useViewerStore(s => s.isLoading)
  const progress = useViewerStore(s => s.loadingProgress)
  const phase = useViewerStore(s => s.loadingPhase)

  if (!isLoading)
    return null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
      <div className="flex w-72 flex-col items-center gap-4 rounded-lg border bg-background p-6 shadow-lg">
        <div className="text-sm font-medium">{phase || 'Loading...'}</div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
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
