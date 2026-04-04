import type { QualityPreset } from '../store'
import { Button } from '@/shared/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { Slider } from '@/shared/components/ui/slider'
import { formatMillions } from '../lib/format'
import { COLOR_MODE_LABELS, ColorMode } from '../renderer/color-modes'
import { useViewerStore } from '../store'

const COLOR_MODE_OPTIONS = [
  ColorMode.RGB,
  ColorMode.Intensity,
  ColorMode.Height,
  ColorMode.Classification,
  ColorMode.White,
] as const

const QUALITY_OPTIONS: QualityPreset[] = ['low', 'medium', 'high']

const QUALITY_LABELS: Record<QualityPreset, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

export function Toolbar() {
  const colorMode = useViewerStore(s => s.colorMode)
  const pointSize = useViewerStore(s => s.pointSize)
  const pointBudget = useViewerStore(s => s.pointBudget)
  const qualityPreset = useViewerStore(s => s.qualityPreset)
  const setColorMode = useViewerStore(s => s.setColorMode)
  const setPointSize = useViewerStore(s => s.setPointSize)
  const setPointBudget = useViewerStore(s => s.setPointBudget)
  const setQualityPreset = useViewerStore(s => s.setQualityPreset)
  const selectionMode = useViewerStore(s => s.selectionMode)
  const setSelectionMode = useViewerStore(s => s.setSelectionMode)
  const selectedPointCount = useViewerStore(s => s.selectedPointCount)
  const clearSelection = useViewerStore(s => s.clearSelection)

  return (
    <div className="flex items-center gap-4 rounded-md bg-background/80 px-3 py-2 shadow-sm backdrop-blur-sm">
      {/* Color mode */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Color</span>
        <Select
          value={String(colorMode)}
          onValueChange={v => setColorMode(Number(v) as ColorMode)}
        >
          <SelectTrigger className="h-7 w-[120px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COLOR_MODE_OPTIONS.map(mode => (
              <SelectItem key={mode} value={String(mode)}>
                {COLOR_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Point size */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Size</span>
        <Slider
          min={1}
          max={10}
          step={0.5}
          value={[pointSize]}
          onValueChange={([v]) => {
            if (v !== undefined)
              setPointSize(v)
          }}
          className="w-20"
        />
        <span className="w-6 text-right text-xs tabular-nums">{pointSize}</span>
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Point budget */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Budget</span>
        <Slider
          min={1_000_000}
          max={10_000_000}
          step={500_000}
          value={[pointBudget]}
          onValueChange={([v]) => {
            if (v !== undefined)
              setPointBudget(v)
          }}
          className="w-24"
        />
        <span className="w-8 text-right text-xs tabular-nums">
          {formatMillions(pointBudget)}
        </span>
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Quality presets */}
      <div className="flex items-center gap-1">
        {QUALITY_OPTIONS.map(preset => (
          <Button
            key={preset}
            variant={qualityPreset === preset ? 'default' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setQualityPreset(preset)}
          >
            {QUALITY_LABELS[preset]}
          </Button>
        ))}
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Selection mode */}
      <div className="flex items-center gap-1">
        <Button
          variant={selectionMode ? 'default' : 'ghost'}
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setSelectionMode(!selectionMode)}
        >
          Select
        </Button>
        {selectedPointCount > 0 && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-destructive"
              onClick={clearSelection}
            >
              Clear
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-destructive"
              onClick={() => {
                // Delete selected — store action stub for FEAT-012
              }}
            >
              Delete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                // Keep selected — store action stub for FEAT-012
              }}
            >
              Keep
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
