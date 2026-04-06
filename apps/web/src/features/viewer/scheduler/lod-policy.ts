import type { Bounds } from '../data/types'

// ---------------------------------------------------------------------------
// Screen-space error (SSE) based LOD policy
//
// The idea: project the node's bounding sphere onto the screen.
// If the projected diameter (in pixels) exceeds a threshold, the node
// should be split (its children loaded at higher detail).
// ---------------------------------------------------------------------------

export interface LodPolicyConfig {
  /** Pixel-error threshold. Nodes whose projected size exceeds this split. Default 1.0 */
  pixelErrorThreshold: number
  /** Minimum node level to always load (root + first N levels). Default 2 */
  baseLevel: number
}

export const DEFAULT_LOD_CONFIG: LodPolicyConfig = {
  pixelErrorThreshold: 1.0,
  baseLevel: 2,
}

// ---------------------------------------------------------------------------
// Compute the projected diameter (in pixels) of a node's bounding sphere
// on screen, given perspective projection parameters.
//
//   projectedSize = (sphereDiameter / distance) * (screenHeight / (2 * tan(fov/2)))
//
// This is the standard perspective projection formula for screen-space size.
// ---------------------------------------------------------------------------

export function computeScreenSpaceError(
  bounds: Bounds,
  cameraPosition: readonly [number, number, number],
  screenHeight: number,
  fov: number,
): number {
  // Bounding sphere: center = midpoint, radius = half-diagonal
  const cx = (bounds.min[0] + bounds.max[0]) * 0.5
  const cy = (bounds.min[1] + bounds.max[1]) * 0.5
  const cz = (bounds.min[2] + bounds.max[2]) * 0.5

  const ex = (bounds.max[0] - bounds.min[0]) * 0.5
  const ey = (bounds.max[1] - bounds.min[1]) * 0.5
  const ez = (bounds.max[2] - bounds.min[2]) * 0.5
  const radius = Math.sqrt(ex * ex + ey * ey + ez * ez)

  // Distance from camera to bounding sphere center
  const dx = cameraPosition[0] - cx
  const dy = cameraPosition[1] - cy
  const dz = cameraPosition[2] - cz
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

  // Avoid division by zero when camera is inside the node
  if (distance < radius) {
    return Infinity
  }

  // Perspective projection factor: pixels per unit at distance=1
  const projectionFactor = screenHeight / (2 * Math.tan(fov * 0.5))

  // Projected diameter in pixels
  return (2 * radius * projectionFactor) / distance
}

// ---------------------------------------------------------------------------
// Decide whether a node should be split (load children) based on SSE.
// Nodes at or below `baseLevel` are always loaded regardless of SSE.
// ---------------------------------------------------------------------------

export function shouldSplit(
  screenSpaceError: number,
  nodeLevel: number,
  config: LodPolicyConfig = DEFAULT_LOD_CONFIG,
): boolean {
  if (nodeLevel < config.baseLevel) {
    return true
  }
  return screenSpaceError > config.pixelErrorThreshold
}
