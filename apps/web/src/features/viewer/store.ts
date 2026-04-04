import type { DatasetDescriptor } from './data/types'
import { create } from 'zustand'
import { ColorMode } from './renderer/color-modes'

export type QualityPreset = 'low' | 'medium' | 'high'

export interface DatasetInfo {
  fileName: string
  sourceFormat: string
  totalPoints: number
}

/** Per-tile selection bitmask: 1 = selected, 0 = not */
export type SelectionMap = Map<string, Uint8Array>

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

  // Selection
  selectionMode: boolean
  selectionMap: SelectionMap
  selectedPointCount: number
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
  setSelectionMode: (enabled: boolean) => void
  setSelection: (selectionMap: SelectionMap) => void
  clearSelection: () => void
  removeSelectionTile: (nodeId: string) => void
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
  selectionMode: false,
  selectionMap: new Map(),
  selectedPointCount: 0,
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

  reset: () => set(initialState),
}))
