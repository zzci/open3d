import type { DatasetDescriptor } from './data/types'
import type { RenderModeId } from './renderer/render-modes'
import { create } from 'zustand'
import { ColorMode } from './renderer/color-modes'
import { PaletteId } from './renderer/palettes/palette-registry'

export type SsaoSampleCount = 8 | 16 | 32
export type QualityPreset = 'low' | 'medium' | 'high'
export type IntensityNormMode = 'linear' | 'histogram'
export type DpiScale = 1 | 1.5 | 2 | 'auto'

export interface DatasetInfo {
  fileName: string
  sourceFormat: string
  totalPoints: number
}

/** Per-tile selection bitmask: 1 = selected, 0 = not */
export type SelectionMap = Map<string, Uint8Array>

export type ExportPhase = 'counting' | 'writing' | 'finalizing'

export interface ViewerState {
  // Render settings
  renderMode: RenderModeId
  colorMode: ColorMode
  sizeMultiplier: number
  pointBudget: number
  qualityPreset: QualityPreset

  // Intensity normalization
  intensityNormMode: IntensityNormMode
  paletteId: PaletteId

  // DPI & quality
  dpiScale: DpiScale

  // EDL (Eye-Dome Lighting)
  edlEnabled: boolean
  edlRadius: number // 1-5
  edlStrength: number // 0-1
  edlExponent: number // 0.5-5

  // SSAO (Screen-Space Ambient Occlusion)
  ssaoEnabled: boolean
  ssaoRadius: number // 0.1-2.0 world units
  ssaoIntensity: number // 0-1
  ssaoSamples: 8 | 16 | 32

  // Loading
  isLoading: boolean
  loadingProgress: number
  loadingPhase: string

  // Dataset
  datasetInfo: DatasetInfo | null
  descriptor: DatasetDescriptor | null
  file: File | null

  // Runtime stats (updated from animation loop)
  loadedPointCount: number
  activeTileCount: number
  fps: number
  dpiAutoDownscaled: boolean

  // Selection
  selectionMode: boolean
  selectionMap: SelectionMap
  selectedPointCount: number

  // Export
  isExporting: boolean
  exportProgress: number
  exportPhase: ExportPhase | ''
  exportPointsProcessed: number
  exportTotalPoints: number
  exportBytesWritten: number
}

export interface ViewerActions {
  setRenderMode: (mode: RenderModeId) => void
  setColorMode: (mode: ColorMode) => void
  setIntensityNormMode: (mode: IntensityNormMode) => void
  setPaletteId: (id: PaletteId) => void
  setSizeMultiplier: (multiplier: number) => void
  setPointBudget: (budget: number) => void
  setQualityPreset: (preset: QualityPreset) => void
  setDpiScale: (scale: DpiScale) => void
  setDpiAutoDownscaled: (downscaled: boolean) => void
  setEdlEnabled: (enabled: boolean) => void
  setEdlRadius: (radius: number) => void
  setEdlStrength: (strength: number) => void
  setEdlExponent: (exponent: number) => void
  setSsaoEnabled: (enabled: boolean) => void
  setSsaoRadius: (radius: number) => void
  setSsaoIntensity: (intensity: number) => void
  setSsaoSamples: (samples: 8 | 16 | 32) => void
  setLoading: (isLoading: boolean, phase?: string) => void
  setLoadingProgress: (progress: number) => void
  setDataset: (descriptor: DatasetDescriptor, file: File) => void
  updateStats: (stats: { loadedPointCount: number, activeTileCount: number, fps: number }) => void
  setSelectionMode: (enabled: boolean) => void
  setSelection: (selectionMap: SelectionMap) => void
  clearSelection: () => void
  removeSelectionTile: (nodeId: string) => void
  setExporting: (isExporting: boolean) => void
  updateExportProgress: (data: { phase: ExportPhase, pointsProcessed: number, totalPoints: number, bytesWritten: number }) => void
  reset: () => void
}

const POINT_BUDGETS: Record<QualityPreset, number> = {
  low: 2_000_000,
  medium: 4_000_000,
  high: 8_000_000,
}

const initialState: ViewerState = {
  renderMode: 'shaded' as RenderModeId,
  colorMode: ColorMode.RGB,
  intensityNormMode: 'linear' as IntensityNormMode,
  paletteId: PaletteId.Viridis,
  sizeMultiplier: 1.0,
  pointBudget: POINT_BUDGETS.medium,
  qualityPreset: 'medium',
  dpiScale: 'auto' as DpiScale,
  edlEnabled: false,
  edlRadius: 2,
  edlStrength: 0.5,
  edlExponent: 1.0,
  ssaoEnabled: false,
  ssaoRadius: 0.5,
  ssaoIntensity: 0.5,
  ssaoSamples: 16,
  isLoading: false,
  loadingProgress: 0,
  loadingPhase: '',
  datasetInfo: null,
  descriptor: null,
  file: null,
  loadedPointCount: 0,
  activeTileCount: 0,
  fps: 0,
  dpiAutoDownscaled: false,
  selectionMode: false,
  selectionMap: new Map(),
  selectedPointCount: 0,
  isExporting: false,
  exportProgress: 0,
  exportPhase: '',
  exportPointsProcessed: 0,
  exportTotalPoints: 0,
  exportBytesWritten: 0,
}

export const useViewerStore = create<ViewerState & ViewerActions>()(set => ({
  ...initialState,

  setRenderMode: mode => set({ renderMode: mode }),

  setColorMode: mode => set({ colorMode: mode }),

  setIntensityNormMode: mode => set({ intensityNormMode: mode }),
  setPaletteId: id => set({ paletteId: id }),

  setSizeMultiplier: multiplier => set({ sizeMultiplier: multiplier }),

  setPointBudget: budget => set({ pointBudget: budget }),

  setDpiScale: scale => set({ dpiScale: scale, dpiAutoDownscaled: false }),
  setDpiAutoDownscaled: downscaled => set({ dpiAutoDownscaled: downscaled }),

  setEdlEnabled: enabled => set({ edlEnabled: enabled }),

  setEdlRadius: radius => set({ edlRadius: radius }),

  setEdlStrength: strength => set({ edlStrength: strength }),

  setEdlExponent: exponent => set({ edlExponent: exponent }),

  setSsaoEnabled: enabled => set({ ssaoEnabled: enabled }),

  setSsaoRadius: radius => set({ ssaoRadius: radius }),

  setSsaoIntensity: intensity => set({ ssaoIntensity: intensity }),

  setSsaoSamples: samples => set({ ssaoSamples: samples }),

  setQualityPreset: (preset) => {
    set({
      qualityPreset: preset,
      pointBudget: POINT_BUDGETS[preset],
    })
  },

  setLoading: (isLoading, phase = '') => set({
    isLoading,
    loadingPhase: phase,
    loadingProgress: isLoading ? 0 : 0,
  }),

  setLoadingProgress: progress => set({ loadingProgress: progress }),

  setDataset: (descriptor, file) => set({
    descriptor,
    file,
    datasetInfo: {
      fileName: descriptor.fileName,
      sourceFormat: descriptor.sourceFormat,
      totalPoints: descriptor.pointCount,
    },
  }),

  updateStats: stats => set(stats),

  setSelectionMode: enabled => set({ selectionMode: enabled }),

  setSelection: (selectionMap) => {
    let count = 0
    for (const mask of selectionMap.values()) {
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] === 1)
          count++
      }
    }
    set({ selectionMap, selectedPointCount: count })
  },

  clearSelection: () => set({ selectionMap: new Map(), selectedPointCount: 0 }),

  removeSelectionTile: (nodeId) => {
    set((state) => {
      const next = new Map(state.selectionMap)
      const removed = next.get(nodeId)
      if (!removed)
        return state
      next.delete(nodeId)
      let delta = 0
      for (let i = 0; i < removed.length; i++) {
        if (removed[i] === 1)
          delta++
      }
      return { selectionMap: next, selectedPointCount: state.selectedPointCount - delta }
    })
  },

  setExporting: isExporting => set({
    isExporting,
    ...(!isExporting && {
      exportProgress: 0,
      exportPhase: '' as const,
      exportPointsProcessed: 0,
      exportTotalPoints: 0,
      exportBytesWritten: 0,
    }),
  }),

  updateExportProgress: ({ phase, pointsProcessed, totalPoints, bytesWritten }) => set({
    exportPhase: phase,
    exportPointsProcessed: pointsProcessed,
    exportTotalPoints: totalPoints,
    exportBytesWritten: bytesWritten,
    exportProgress: totalPoints > 0 ? (pointsProcessed / totalPoints) * 100 : 0,
  }),

  reset: () => set(initialState),
}))
