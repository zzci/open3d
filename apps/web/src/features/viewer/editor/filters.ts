import type { Bounds, TileData } from '../data/types'
import type { EditEntry } from './edit-log'

/**
 * Builds a visibility mask for a tile based on the active edit entries.
 *
 * Returns a Uint8Array where 0 = visible, 1 = hidden.
 * If no edits affect the tile, returns null (all points visible).
 */
export function buildTileMask(
  tile: TileData,
  activeEntries: readonly EditEntry[],
): Uint8Array | null {
  if (activeEntries.length === 0)
    return null

  let mask: Uint8Array | null = null

  for (const entry of activeEntries) {
    const { operation } = entry

    switch (operation.type) {
      case 'deleteBySelection': {
        const tileMask = operation.masks.find(m => m.tileId === tile.nodeId)
        if (tileMask) {
          mask = ensureMask(mask, tile.pointCount)
          applySelectionMask(mask, tileMask.mask)
        }
        break
      }
      case 'keepByAABB': {
        mask = ensureMask(mask, tile.pointCount)
        applyAABBFilter(mask, tile, operation.bounds, false)
        break
      }
      case 'filterByClassification': {
        if (tile.classification) {
          mask = ensureMask(mask, tile.pointCount)
          applyClassificationFilter(mask, tile.classification, operation.classes)
        }
        break
      }
      case 'filterByRange': {
        const attrData = getAttributeData(tile, operation.attribute)
        if (attrData) {
          mask = ensureMask(mask, tile.pointCount)
          applyRangeFilter(mask, attrData, operation.min, operation.max)
        }
        break
      }
    }
  }

  return mask
}

function ensureMask(mask: Uint8Array | null, pointCount: number): Uint8Array {
  return mask ?? new Uint8Array(pointCount)
}

/**
 * Apply a per-point selection mask. Points marked 1 in selectionMask are hidden.
 */
function applySelectionMask(mask: Uint8Array, selectionMask: Uint8Array): void {
  const len = Math.min(mask.length, selectionMask.length)
  for (let i = 0; i < len; i++) {
    if (selectionMask[i])
      mask[i] = 1
  }
}

/**
 * Keep only points inside the AABB. Points outside are hidden.
 * If `invert` is true, hides points inside instead.
 */
function applyAABBFilter(
  mask: Uint8Array,
  tile: TileData,
  bounds: Bounds,
  invert: boolean,
): void {
  const positions = tile.positions
  const [minX, minY, minZ] = bounds.min
  const [maxX, maxY, maxZ] = bounds.max

  for (let i = 0; i < tile.pointCount; i++) {
    if (mask[i])
      continue // already hidden

    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    const z = positions[i * 3 + 2]

    const inside = x >= minX && x <= maxX
      && y >= minY && y <= maxY
      && z >= minZ && z <= maxZ

    if (invert ? inside : !inside) {
      mask[i] = 1
    }
  }
}

/**
 * Hide points whose classification is NOT in the allowed set.
 */
function applyClassificationFilter(
  mask: Uint8Array,
  classification: Uint8Array,
  allowedClasses: number[],
): void {
  const allowed = new Set(allowedClasses)
  for (let i = 0; i < mask.length; i++) {
    if (mask[i])
      continue
    if (!allowed.has(classification[i]!)) {
      mask[i] = 1
    }
  }
}

/**
 * Hide points whose attribute value is outside [min, max].
 */
function applyRangeFilter(
  mask: Uint8Array,
  attrData: Float32Array | Uint8Array,
  min: number,
  max: number,
): void {
  for (let i = 0; i < mask.length; i++) {
    if (mask[i])
      continue
    const v = attrData[i]!
    if (v < min || v > max) {
      mask[i] = 1
    }
  }
}

function getAttributeData(
  tile: TileData,
  attribute: string,
): Float32Array | Uint8Array | null {
  switch (attribute) {
    case 'intensity': return tile.intensity ?? null
    case 'classification': return tile.classification ?? null
    default: return null
  }
}

// --- Tile mask cache ---

export interface TileMaskCache {
  readonly masks: ReadonlyMap<string, Uint8Array | null>
  readonly logVersion: number // pointer value when cache was built
}

export function createTileMaskCache(): TileMaskCache {
  return { masks: new Map(), logVersion: -1 }
}

/**
 * Get or compute the mask for a tile. Returns the mask and updated cache.
 */
export function getCachedTileMask(
  cache: TileMaskCache,
  tile: TileData,
  activeEntries: readonly EditEntry[],
  logVersion: number,
): { mask: Uint8Array | null, cache: TileMaskCache } {
  // Invalidate entire cache if log version changed
  if (cache.logVersion !== logVersion) {
    const mask = buildTileMask(tile, activeEntries)
    const masks = new Map([[tile.nodeId, mask]])
    return { mask, cache: { masks, logVersion } }
  }

  const cached = cache.masks.get(tile.nodeId)
  if (cached !== undefined) {
    return { mask: cached, cache }
  }

  const mask = buildTileMask(tile, activeEntries)
  const masks = new Map(cache.masks)
  masks.set(tile.nodeId, mask)
  return { mask, cache: { masks, logVersion } }
}
