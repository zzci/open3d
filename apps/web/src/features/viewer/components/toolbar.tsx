import type { QualityPreset, SsaoSampleCount } from '../store'
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
import { PALETTE_LABELS, PaletteId } from '../renderer/palettes/palette-registry'
import { useViewerStore } from '../store'

interface ToolbarProps {
  onExport?: () => void
  onDeleteSelected?: () => void
  onKeepSelected?: () => void
}

const COLOR_MODE_OPTIONS = [
  ColorMode.RGB,
  ColorMode.Intensity,
  ColorMode.Height,
  ColorMode.Classification,
  ColorMode.White,
] as const

const PALETTE_OPTIONS = Object.values(PaletteId)

const QUALITY_OPTIONS: QualityPreset[] = ['low', 'medium', 'high']

const QUALITY_LABELS: Record<QualityPreset, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

export function Toolbar({ onExport, onDeleteSelected, onKeepSelected }: ToolbarProps) {
  const colorMode = useViewerStore(s => s.colorMode)
  const paletteId = useViewerStore(s => s.paletteId)
  const sizeMultiplier = useViewerStore(s => s.sizeMultiplier)
  const pointBudget = useViewerStore(s => s.pointBudget)
  const qualityPreset = useViewerStore(s => s.qualityPreset)
  const descriptor = useViewerStore(s => s.descriptor)
  const isExporting = useViewerStore(s => s.isExporting)
  const setColorMode = useViewerStore(s => s.setColorMode)
  const setPaletteId = useViewerStore(s => s.setPaletteId)
  const setSizeMultiplier = useViewerStore(s => s.setSizeMultiplier)
  const setPointBudget = useViewerStore(s => s.setPointBudget)
  const setQualityPreset = useViewerStore(s => s.setQualityPreset)
  const edlEnabled = useViewerStore(s => s.edlEnabled)
  const edlStrength = useViewerStore(s => s.edlStrength)
  const setEdlEnabled = useViewerStore(s => s.setEdlEnabled)
  const setEdlStrength = useViewerStore(s => s.setEdlStrength)
  const ssaoEnabled = useViewerStore(s => s.ssaoEnabled)
  const ssaoRadius = useViewerStore(s => s.ssaoRadius)
  const ssaoIntensity = useViewerStore(s => s.ssaoIntensity)
  const ssaoSamples = useViewerStore(s => s.ssaoSamples)
  const setSsaoEnabled = useViewerStore(s => s.setSsaoEnabled)
  const setSsaoRadius = useViewerStore(s => s.setSsaoRadius)
  const setSsaoIntensity = useViewerStore(s => s.setSsaoIntensity)
  const setSsaoSamples = useViewerStore(s => s.setSsaoSamples)
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

      {/* Palette — visible for intensity/height modes */}
      {(colorMode === ColorMode.Intensity || colorMode === ColorMode.Height) && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Palette</span>
          <Select
            value={paletteId}
            onValueChange={v => setPaletteId(v as PaletteId)}
          >
            <SelectTrigger className="h-7 w-[100px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PALETTE_OPTIONS.map(id => (
                <SelectItem key={id} value={id}>
                  {PALETTE_LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="h-4 w-px bg-border" />

      {/* Size multiplier */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Size</span>
        <Slider
          min={0.5}
          max={3}
          step={0.1}
          value={[sizeMultiplier]}
          onValueChange={([v]) => {
            if (v !== undefined)
              setSizeMultiplier(v)
          }}
          className="w-20"
        />
        <span className="w-8 text-right text-xs tabular-nums">{sizeMultiplier.toFixed(1)}</span>
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

      {/* EDL (Eye-Dome Lighting) */}
      <div className="flex items-center gap-2">
        <Button
          variant={edlEnabled ? 'default' : 'ghost'}
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setEdlEnabled(!edlEnabled)}
        >
          EDL
        </Button>
        {edlEnabled && (
          <>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={[edlStrength]}
              onValueChange={([v]) => {
                if (v !== undefined)
                  setEdlStrength(v)
              }}
              className="w-16"
            />
            <span className="w-6 text-right text-xs tabular-nums">
              {Math.round(edlStrength * 100)}
            </span>
          </>
        )}
      </div>

      {/* SSAO (Screen-Space Ambient Occlusion) */}
      <div className="flex items-center gap-2">
        <Button
          variant={ssaoEnabled ? 'default' : 'ghost'}
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setSsaoEnabled(!ssaoEnabled)}
        >
          SSAO
        </Button>
        {ssaoEnabled && (
          <>
            <span className="text-xs text-muted-foreground">R</span>
            <Slider
              min={0.1}
              max={2}
              step={0.1}
              value={[ssaoRadius]}
              onValueChange={([v]) => {
                if (v !== undefined)
                  setSsaoRadius(v)
              }}
              className="w-14"
            />
            <span className="text-xs text-muted-foreground">I</span>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={[ssaoIntensity]}
              onValueChange={([v]) => {
                if (v !== undefined)
                  setSsaoIntensity(v)
              }}
              className="w-14"
            />
            <Select
              value={String(ssaoSamples)}
              onValueChange={v => setSsaoSamples(Number(v) as SsaoSampleCount)}
            >
              <SelectTrigger className="h-7 w-[60px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="8">8</SelectItem>
                <SelectItem value="16">16</SelectItem>
                <SelectItem value="32">32</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}
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
              onClick={onDeleteSelected}
            >
              Delete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onKeepSelected}
            >
              Keep
            </Button>
          </>
        )}
      </div>

      {onExport && (
        <>
          <div className="h-4 w-px bg-border" />

          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={!descriptor || isExporting}
            onClick={onExport}
          >
            Export LAS
          </Button>
        </>
      )}
    </div>
  )
}
