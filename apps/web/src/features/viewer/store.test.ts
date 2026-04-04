import type { DatasetDescriptor } from './data/types'
import { afterEach, describe, expect, it } from 'vitest'
import { ColorMode } from './renderer/color-modes'
import { useViewerStore } from './store'

function resetStore() {
  useViewerStore.getState().reset()
}

afterEach(resetStore)

describe('useViewerStore', () => {
  describe('initial state', () => {
    it('has default render settings', () => {
      const state = useViewerStore.getState()
      expect(state.colorMode).toBe(ColorMode.RGB)
      expect(state.sizeMultiplier).toBe(1.0)
      expect(state.pointBudget).toBe(4_000_000)
      expect(state.qualityPreset).toBe('medium')
    })

    it('has no dataset loaded', () => {
      const state = useViewerStore.getState()
      expect(state.isLoading).toBe(false)
      expect(state.datasetInfo).toBeNull()
      expect(state.descriptor).toBeNull()
      expect(state.file).toBeNull()
    })
  })

  describe('setColorMode', () => {
    it('updates color mode', () => {
      useViewerStore.getState().setColorMode(ColorMode.Height)
      expect(useViewerStore.getState().colorMode).toBe(ColorMode.Height)
    })
  })

  describe('setSizeMultiplier', () => {
    it('updates size multiplier', () => {
      useViewerStore.getState().setSizeMultiplier(2.5)
      expect(useViewerStore.getState().sizeMultiplier).toBe(2.5)
    })
  })

  describe('setPointBudget', () => {
    it('updates point budget', () => {
      useViewerStore.getState().setPointBudget(6_000_000)
      expect(useViewerStore.getState().pointBudget).toBe(6_000_000)
    })
  })

  describe('setQualityPreset', () => {
    it('updates preset and syncs point budget', () => {
      useViewerStore.getState().setQualityPreset('high')
      const state = useViewerStore.getState()
      expect(state.qualityPreset).toBe('high')
      expect(state.pointBudget).toBe(8_000_000)
    })

    it('sets low preset budget', () => {
      useViewerStore.getState().setQualityPreset('low')
      expect(useViewerStore.getState().pointBudget).toBe(2_000_000)
    })
  })

  describe('setLoading', () => {
    it('sets loading state with phase', () => {
      useViewerStore.getState().setLoading(true, 'Reading header...')
      const state = useViewerStore.getState()
      expect(state.isLoading).toBe(true)
      expect(state.loadingPhase).toBe('Reading header...')
      expect(state.loadingProgress).toBe(0)
    })

    it('clears loading state', () => {
      useViewerStore.getState().setLoading(true, 'test')
      useViewerStore.getState().setLoading(false)
      const state = useViewerStore.getState()
      expect(state.isLoading).toBe(false)
      expect(state.loadingPhase).toBe('')
    })
  })

  describe('setDataset', () => {
    it('sets descriptor and dataset info', () => {
      const descriptor: DatasetDescriptor = {
        id: 'test-id',
        sourceFormat: 'copc',
        fileName: 'test.copc.laz',
        fileSize: 1024,
        pointCount: 5_000_000,
        pointFormat: 7,
        bounds: { min: [0, 0, 0], max: [100, 100, 100] },
        scale: [0.001, 0.001, 0.001],
        offset: [0, 0, 0],
        attributes: ['x', 'y', 'z'],
        hierarchyDepth: 5,
        rootNodeId: '0-0-0-0',
        cached: false,
      }
      const file = new File([], 'test.copc.laz')

      useViewerStore.getState().setDataset(descriptor, file)
      const state = useViewerStore.getState()

      expect(state.descriptor).toBe(descriptor)
      expect(state.file).toBe(file)
      expect(state.datasetInfo).toEqual({
        fileName: 'test.copc.laz',
        sourceFormat: 'copc',
        totalPoints: 5_000_000,
      })
    })
  })

  describe('updateStats', () => {
    it('updates runtime stats', () => {
      useViewerStore.getState().updateStats({
        loadedPointCount: 1_000_000,
        activeTileCount: 42,
        fps: 59.8,
      })
      const state = useViewerStore.getState()
      expect(state.loadedPointCount).toBe(1_000_000)
      expect(state.activeTileCount).toBe(42)
      expect(state.fps).toBe(59.8)
    })
  })

  describe('reset', () => {
    it('resets to initial state', () => {
      useViewerStore.getState().setColorMode(ColorMode.Height)
      useViewerStore.getState().setSizeMultiplier(2.5)
      useViewerStore.getState().setLoading(true, 'test')
      useViewerStore.getState().reset()

      const state = useViewerStore.getState()
      expect(state.colorMode).toBe(ColorMode.RGB)
      expect(state.sizeMultiplier).toBe(1.0)
      expect(state.isLoading).toBe(false)
      expect(state.datasetInfo).toBeNull()
    })
  })
})
