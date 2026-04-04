import type { Bounds } from '../data/types'

// ---------------------------------------------------------------------------
// Frustum plane: [a, b, c, d] where ax + by + cz + d >= 0 is inside
// ---------------------------------------------------------------------------

export type FrustumPlane = [number, number, number, number]

export interface ViewState {
  frustumPlanes: readonly FrustumPlane[]
  cameraPosition: readonly [number, number, number]
  screenHeight: number
  fov: number // vertical field-of-view in radians
}

// ---------------------------------------------------------------------------
// Extract 6 frustum planes from a 4x4 view-projection matrix (column-major)
// Uses Gribb-Hartmann method. Planes point inward (positive half-space = inside).
// ---------------------------------------------------------------------------

export function extractFrustumPlanes(
  viewProjection: Float32Array | readonly number[],
): FrustumPlane[] {
  const m = viewProjection
  // Column-major indexing: m[col*4 + row]
  const planes: FrustumPlane[] = [
    // Left:   row3 + row0
    normalizePlane(m[3]! + m[0]!, m[7]! + m[4]!, m[11]! + m[8]!, m[15]! + m[12]!),
    // Right:  row3 - row0
    normalizePlane(m[3]! - m[0]!, m[7]! - m[4]!, m[11]! - m[8]!, m[15]! - m[12]!),
    // Bottom: row3 + row1
    normalizePlane(m[3]! + m[1]!, m[7]! + m[5]!, m[11]! + m[9]!, m[15]! + m[13]!),
    // Top:    row3 - row1
    normalizePlane(m[3]! - m[1]!, m[7]! - m[5]!, m[11]! - m[9]!, m[15]! - m[13]!),
    // Near:   row3 + row2
    normalizePlane(m[3]! + m[2]!, m[7]! + m[6]!, m[11]! + m[10]!, m[15]! + m[14]!),
    // Far:    row3 - row2
    normalizePlane(m[3]! - m[2]!, m[7]! - m[6]!, m[11]! - m[10]!, m[15]! - m[14]!),
  ]
  return planes
}

function normalizePlane(a: number, b: number, c: number, d: number): FrustumPlane {
  const len = Math.sqrt(a * a + b * b + c * c)
  if (len === 0)
    return [0, 0, 0, 0]
  const inv = 1 / len
  return [a * inv, b * inv, c * inv, d * inv]
}

// ---------------------------------------------------------------------------
// Frustum-AABB intersection test
// Returns true if the AABB is at least partially inside the frustum.
// Uses the "p-vertex" approach for fast conservative rejection.
// ---------------------------------------------------------------------------

export function intersectsFrustum(
  bounds: Bounds,
  planes: readonly FrustumPlane[],
): boolean {
  const { min, max } = bounds

  for (let i = 0; i < planes.length; i++) {
    const [a, b, c, d] = planes[i]!

    // Find the p-vertex (the corner most in the direction of the plane normal)
    const px = a >= 0 ? max[0] : min[0]
    const py = b >= 0 ? max[1] : min[1]
    const pz = c >= 0 ? max[2] : min[2]

    // If the p-vertex is outside, the entire AABB is outside this plane
    if (a * px + b * py + c * pz + d < 0) {
      return false
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// Camera idle detection — debounce camera movement by `delayMs`.
// Calls `onIdle` after the camera has been still for `delayMs`.
// ---------------------------------------------------------------------------

export interface CameraIdleDetector {
  /** Call on every camera change (e.g. OrbitControls 'change' event) */
  onCameraMove: () => void
  /** Clean up the timer */
  dispose: () => void
}

export function createCameraIdleDetector(
  onIdle: () => void,
  delayMs: number = 300,
): CameraIdleDetector {
  let timerId: ReturnType<typeof setTimeout> | null = null

  function onCameraMove(): void {
    if (timerId !== null) {
      clearTimeout(timerId)
    }
    timerId = setTimeout(() => {
      timerId = null
      onIdle()
    }, delayMs)
  }

  function dispose(): void {
    if (timerId !== null) {
      clearTimeout(timerId)
      timerId = null
    }
  }

  return { onCameraMove, dispose }
}

// ---------------------------------------------------------------------------
// Distance from camera to AABB center
// ---------------------------------------------------------------------------

export function distanceToBoundsCenter(
  cameraPosition: readonly [number, number, number],
  bounds: Bounds,
): number {
  const cx = (bounds.min[0] + bounds.max[0]) * 0.5
  const cy = (bounds.min[1] + bounds.max[1]) * 0.5
  const cz = (bounds.min[2] + bounds.max[2]) * 0.5
  const dx = cameraPosition[0] - cx
  const dy = cameraPosition[1] - cy
  const dz = cameraPosition[2] - cz
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}
