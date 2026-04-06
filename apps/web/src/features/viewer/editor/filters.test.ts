import type { TileData } from '../data/types'
import type { EditEntry, EditOperation } from './edit-log'
import { describe, expect, it } from 'vitest'
import { buildTileMask, createTileMaskCache, getCachedTileMask } from './filters'

function makeTile(overrides: Partial<TileData> = {}): TileData {
  return {
    nodeId: 'tile-1',
    level: 0,
    pointCount: 4,
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    positions: new Float32Array([
      1,
      1,
      1, // point 0: inside [0,5]
      6,
      6,
      6, // point 1: outside [0,5]
      3,
      3,
      3, // point 2: inside [0,5]
      8,
      8,
      8, // point 3: outside [0,5]
    ]),
    ...overrides,
  }
}

function makeEntry(operation: EditOperation, id = 'e1'): EditEntry {
  return {
    id,
    operation,
    affectedTileIds: [],
    cameraState: null,
    timestamp: Date.now(),
  }
}

describe('filters', () => {
  describe('buildTileMask', () => {
    it('returns null for empty entries', () => {
      const tile = makeTile()
      expect(buildTileMask(tile, [])).toBeNull()
    })

    it('applies deleteBySelection', () => {
      const tile = makeTile()
      const entry = makeEntry({
        type: 'deleteBySelection',
        masks: [{ tileId: 'tile-1', mask: new Uint8Array([0, 1, 0, 1]) }],
      })

      const mask = buildTileMask(tile, [entry])
      expect(Array.from(mask!)).toEqual([0, 1, 0, 1])
    })

    it('skips deleteBySelection for non-matching tile', () => {
      const tile = makeTile()
      const entry = makeEntry({
        type: 'deleteBySelection',
        masks: [{ tileId: 'other-tile', mask: new Uint8Array([1, 1, 1, 1]) }],
      })

      const mask = buildTileMask(tile, [entry])
      // No mask created since the operation doesn't target this tile
      // But still returns null since no operations affected the tile
      expect(mask).toBeNull()
    })

    it('applies keepByAABB — hides points outside bounds', () => {
      const tile = makeTile()
      const entry = makeEntry({
        type: 'keepByAABB',
        bounds: { min: [0, 0, 0], max: [5, 5, 5] },
      })

      const mask = buildTileMask(tile, [entry])
      // points 0,2 inside, points 1,3 outside
      expect(Array.from(mask!)).toEqual([0, 1, 0, 1])
    })

    it('applies filterByClassification', () => {
      const tile = makeTile({
        classification: new Uint8Array([2, 6, 2, 9]),
      })
      const entry = makeEntry({
        type: 'filterByClassification',
        classes: [2, 6],
      })

      const mask = buildTileMask(tile, [entry])
      // point 3 (class=9) should be hidden
      expect(Array.from(mask!)).toEqual([0, 0, 0, 1])
    })

    it('applies filterByRange on intensity', () => {
      const tile = makeTile({
        intensity: new Float32Array([50, 150, 200, 10]),
      })
      const entry = makeEntry({
        type: 'filterByRange',
        attribute: 'intensity',
        min: 40,
        max: 160,
      })

      const mask = buildTileMask(tile, [entry])
      // point 2 (200) and point 3 (10) outside range
      expect(Array.from(mask!)).toEqual([0, 0, 1, 1])
    })

    it('combines multiple operations', () => {
      const tile = makeTile({
        classification: new Uint8Array([2, 6, 2, 6]),
      })

      const entries = [
        // First: keep only inside AABB [0,5] — hides points 1,3
        makeEntry(
          { type: 'keepByAABB', bounds: { min: [0, 0, 0], max: [5, 5, 5] } },
          'e1',
        ),
        // Second: filter to class 6 — hides points 0,2
        makeEntry(
          { type: 'filterByClassification', classes: [6] },
          'e2',
        ),
      ]

      const mask = buildTileMask(tile, entries)
      // point 0: inside AABB but class=2 → hidden
      // point 1: outside AABB → hidden (class=6 doesn't save it)
      // point 2: inside AABB but class=2 → hidden
      // point 3: outside AABB → hidden
      expect(Array.from(mask!)).toEqual([1, 1, 1, 1])
    })
  })

  describe('tileMaskCache', () => {
    it('caches tile masks by version', () => {
      const tile = makeTile()
      const entries = [makeEntry({
        type: 'keepByAABB',
        bounds: { min: [0, 0, 0], max: [5, 5, 5] },
      })]

      let cache = createTileMaskCache()

      const r1 = getCachedTileMask(cache, tile, entries, 1)
      cache = r1.cache
      expect(r1.mask).not.toBeNull()
      expect(cache.logVersion).toBe(1)

      // Same version, same tile — should return cached
      const r2 = getCachedTileMask(cache, tile, entries, 1)
      expect(r2.mask).toBe(r1.mask) // same reference
    })

    it('invalidates on version change', () => {
      const tile = makeTile()
      const entries = [makeEntry({
        type: 'keepByAABB',
        bounds: { min: [0, 0, 0], max: [5, 5, 5] },
      })]

      let cache = createTileMaskCache()
      const r1 = getCachedTileMask(cache, tile, entries, 1)
      cache = r1.cache

      // New version invalidates cache
      const r2 = getCachedTileMask(cache, tile, entries, 2)
      expect(r2.cache.logVersion).toBe(2)
    })
  })
})
