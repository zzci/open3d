/**
 * Temporary edit log types for FEAT-013 (export).
 * Will be replaced by FEAT-012's canonical definitions.
 */

import type { Bounds } from '../data/types'

export type EditOperationType
  = | 'deleteBySelection'
    | 'keepByAABB'
    | 'filterByClassification'
    | 'filterByRange'

export interface DeleteBySelectionParams {
  /** Per-node point index masks — nodeId → Set of point indices to delete */
  masks: Record<string, Set<number>>
}

export interface KeepByAABBParams {
  bounds: Bounds
}

export interface FilterByClassificationParams {
  /** Classification codes to keep */
  keep: number[]
}

export interface FilterByRangeParams {
  attribute: 'intensity' | 'z'
  min: number
  max: number
}

export type EditLogParams
  = | DeleteBySelectionParams
    | KeepByAABBParams
    | FilterByClassificationParams
    | FilterByRangeParams

export interface EditLogEntry {
  type: EditOperationType
  params: EditLogParams
  timestamp: number
}

/**
 * Applies the full edit log to determine whether a single point passes all filters.
 *
 * Returns true if the point should be KEPT in the export.
 */
export function pointPassesEditLog(
  entries: readonly EditLogEntry[],
  point: { x: number, y: number, z: number, intensity: number, classification: number },
  _nodeId: string,
  _pointIndex: number,
): boolean {
  for (const entry of entries) {
    switch (entry.type) {
      case 'deleteBySelection': {
        const params = entry.params as DeleteBySelectionParams
        const mask = params.masks[_nodeId]
        if (mask?.has(_pointIndex))
          return false
        break
      }
      case 'keepByAABB': {
        const { bounds } = entry.params as KeepByAABBParams
        if (
          point.x < bounds.min[0] || point.x > bounds.max[0]
          || point.y < bounds.min[1] || point.y > bounds.max[1]
          || point.z < bounds.min[2] || point.z > bounds.max[2]
        ) {
          return false
        }
        break
      }
      case 'filterByClassification': {
        const params = entry.params as FilterByClassificationParams
        if (!params.keep.includes(point.classification))
          return false
        break
      }
      case 'filterByRange': {
        const params = entry.params as FilterByRangeParams
        const value = params.attribute === 'z' ? point.z : point.intensity
        if (value < params.min || value > params.max)
          return false
        break
      }
    }
  }
  return true
}
