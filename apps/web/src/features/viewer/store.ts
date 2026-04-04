import type { DatasetDescriptor } from './data/types'
import { create } from 'zustand'
import { ColorMode } from './renderer/color-modes'

export type QualityPreset = 'low' | 'medium' | 'high'

export interface DatasetInfo {
  fileName: string
  sourceFormat: string
  totalPoints: number
}

export type ExportPhase = 'counting' | 'writing' | 'finalizing'

export interface ViewerState {
  // Render settings
  colorMode: ColorMode
  pointSize: number
  pointBudget: number
  qualityPreset: QualityPreset

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

  // Export
  isExporting: boolean
  exportProgress: number
  exportPhase: ExportPhase | ''
  exportPointsProcessed: number
  exportTotalPoints: number
  exportBytesWritten: number
}

export interface ViewerActions {
  setColorMode: (mode: ColorMode) => void
  setPointSize: (size: number) => void
  setPointBudget: (budget: number) => void
  setQualityPreset: (preset: QualityPreset) => void
  setLoading: (isLoading: boolean, phase?: string) => void
  setLoadingProgress: (progress: number) => void
  setDataset: (descriptor: DatasetDescriptor, file: File) => void
  updateStats: (stats: { loadedPointCount: number, activeTileCount: number, fps: number }) => void
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
  colorMode: ColorMode.RGB,
  pointSize: 2,
  pointBudget: POINT_BUDGETS.medium,
  qualityPreset: 'medium',
  isLoading: false,
  loadingProgress: 0,
  loadingPhase: '',
  datasetInfo: null,
  descriptor: null,
  file: null,
  loadedPointCount: 0,
  activeTileCount: 0,
  fps: 0,
  isExporting: false,
  exportProgress: 0,
  exportPhase: '',
  exportPointsProcessed: 0,
  exportTotalPoints: 0,
  exportBytesWritten: 0,
}

export const useViewerStore = create<ViewerState & ViewerActions>()(set => ({
  ...initialState,

  setColorMode: mode => set({ colorMode: mode }),

  setPointSize: size => set({ pointSize: size }),

  setPointBudget: budget => set({ pointBudget: budget }),

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
