/**
 * Hull cross-section extraction and simplified mesh reconstruction.
 *
 * Given a point cloud of a ship hull:
 * 1. PCA to find principal axes (length, beam, depth)
 * 2. Slice at regular intervals along the length axis
 * 3. Extract 2D convex hull for each slice
 * 4. Loft between slices to generate a triangle mesh
 */

// ---------------------------------------------------------------------------
// PCA — find ship's principal axes
// ---------------------------------------------------------------------------

export interface PrincipalAxes {
  center: [number, number, number]
  // Axes sorted by eigenvalue: longest = length, medium = depth, shortest = beam
  lengthAxis: number // 0=x, 1=y, 2=z — which original axis is the ship length
  beamAxis: number
  depthAxis: number
  extents: [number, number, number] // length, beam, depth in meters
}

export function findPrincipalAxes(positions: Float32Array, count: number): PrincipalAxes {
  // Compute centroid
  let cx = 0, cy = 0, cz = 0
  const step = Math.max(1, Math.floor(count / 50000))
  let n = 0
  for (let i = 0; i < count; i += step) {
    cx += positions[i * 3]!
    cy += positions[i * 3 + 1]!
    cz += positions[i * 3 + 2]!
    n++
  }
  cx /= n; cy /= n; cz /= n

  // Compute covariance matrix (3x3, symmetric)
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0
  for (let i = 0; i < count; i += step) {
    const dx = positions[i * 3]! - cx
    const dy = positions[i * 3 + 1]! - cy
    const dz = positions[i * 3 + 2]! - cz
    cxx += dx * dx; cxy += dx * dy; cxz += dx * dz
    cyy += dy * dy; cyz += dy * dz; czz += dz * dz
  }
  cxx /= n; cxy /= n; cxz /= n; cyy /= n; cyz /= n; czz /= n

  // Compute variance along each axis (diagonal of covariance)
  // Simple approach: use axis-aligned variance to determine longest axis
  const variances = [cxx, cyy, czz]
  const sorted = [0, 1, 2].sort((a, b) => variances[b]! - variances[a]!)
  const lengthAxis = sorted[0]! // largest variance = ship length
  const depthAxis = sorted[1]!  // medium = depth
  const beamAxis = sorted[2]!   // smallest = beam

  // Compute extents
  let mins = [Infinity, Infinity, Infinity]
  let maxs = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < count; i += step) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a]!
      if (v < mins[a]!) mins[a] = v
      if (v > maxs[a]!) maxs[a] = v
    }
  }

  return {
    center: [cx, cy, cz],
    lengthAxis,
    beamAxis,
    depthAxis,
    extents: [
      maxs[lengthAxis]! - mins[lengthAxis]!,
      maxs[beamAxis]! - mins[beamAxis]!,
      maxs[depthAxis]! - mins[depthAxis]!,
    ],
  }
}

// ---------------------------------------------------------------------------
// Cross-section extraction
// ---------------------------------------------------------------------------

export interface CrossSection {
  position: number // coordinate along the length axis
  contour: Float32Array // 2D points [beam, depth, beam, depth, ...] ordered by angle
  pointCount: number
  area: number // approximate cross-section area
}

export function extractCrossSections(
  positions: Float32Array,
  count: number,
  axes: PrincipalAxes,
  numSections: number = 20,
): CrossSection[] {
  const { lengthAxis, beamAxis, depthAxis } = axes

  // Find range along length axis
  let lMin = Infinity, lMax = -Infinity
  const step = Math.max(1, Math.floor(count / 100000))
  for (let i = 0; i < count; i += step) {
    const v = positions[i * 3 + lengthAxis]!
    if (v < lMin) lMin = v
    if (v > lMax) lMax = v
  }

  const range = lMax - lMin
  const sliceThickness = range / numSections * 0.5
  const slicePositions: number[] = []
  for (let s = 1; s <= numSections; s++) {
    slicePositions.push(lMin + (range * s) / (numSections + 1))
  }

  const sections: CrossSection[] = []

  for (const pos of slicePositions) {
    // Collect points in this slice
    const beamVals: number[] = []
    const depthVals: number[] = []

    for (let i = 0; i < count; i++) {
      const lv = positions[i * 3 + lengthAxis]!
      if (Math.abs(lv - pos) <= sliceThickness) {
        beamVals.push(positions[i * 3 + beamAxis]!)
        depthVals.push(positions[i * 3 + depthAxis]!)
      }
    }

    if (beamVals.length < 10) continue

    // Compute 2D convex hull
    const hull = convexHull2D(beamVals, depthVals)
    if (hull.length < 6) continue // need at least 3 points

    // Compute area (shoelace formula)
    let area = 0
    const np = hull.length / 2
    for (let i = 0; i < np; i++) {
      const j = (i + 1) % np
      area += hull[i * 2]! * hull[j * 2 + 1]!
      area -= hull[j * 2]! * hull[i * 2 + 1]!
    }
    area = Math.abs(area) / 2

    sections.push({
      position: pos,
      contour: new Float32Array(hull),
      pointCount: beamVals.length,
      area,
    })
  }

  return sections
}

// ---------------------------------------------------------------------------
// 2D Convex Hull (Andrew's monotone chain)
// ---------------------------------------------------------------------------

function convexHull2D(xs: number[], ys: number[]): number[] {
  const n = xs.length
  const pts: [number, number][] = []
  for (let i = 0; i < n; i++) pts.push([xs[i]!, ys[i]!])
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])

  const hull: [number, number][] = []

  // Lower hull
  for (const p of pts) {
    while (hull.length >= 2 && cross(hull[hull.length - 2]!, hull[hull.length - 1]!, p) <= 0)
      hull.pop()
    hull.push(p)
  }

  // Upper hull
  const lower = hull.length + 1
  for (let i = n - 2; i >= 0; i--) {
    const p = pts[i]!
    while (hull.length >= lower && cross(hull[hull.length - 2]!, hull[hull.length - 1]!, p) <= 0)
      hull.pop()
    hull.push(p)
  }

  hull.pop() // remove duplicate last point
  const result: number[] = []
  for (const [x, y] of hull) {
    result.push(x, y)
  }
  return result
}

function cross(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

// ---------------------------------------------------------------------------
// Loft — generate triangle mesh between cross-sections
// ---------------------------------------------------------------------------

export interface LoftMesh {
  positions: Float32Array // xyz interleaved
  indices: Uint32Array    // triangle indices
  vertexCount: number
  triangleCount: number
}

export function loftSections(
  sections: CrossSection[],
  axes: PrincipalAxes,
  pointsPerSection: number = 64,
): LoftMesh {
  const { lengthAxis, beamAxis, depthAxis } = axes

  // Resample each section contour to uniform point count
  const resampled: Array<{ pos: number, points: Float32Array }> = []

  for (const sec of sections) {
    const pts = resampleContour(sec.contour, pointsPerSection)
    resampled.push({ pos: sec.position, points: pts })
  }

  if (resampled.length < 2) {
    return { positions: new Float32Array(0), indices: new Uint32Array(0), vertexCount: 0, triangleCount: 0 }
  }

  // Generate 3D vertices
  const nSec = resampled.length
  const nPts = pointsPerSection
  const vertexCount = nSec * nPts
  const positions = new Float32Array(vertexCount * 3)

  for (let s = 0; s < nSec; s++) {
    const sec = resampled[s]!
    for (let p = 0; p < nPts; p++) {
      const vi = (s * nPts + p) * 3
      // Map 2D (beam, depth) back to 3D
      const beam = sec.points[p * 2]!
      const depth = sec.points[p * 2 + 1]!
      positions[vi + lengthAxis] = sec.pos
      positions[vi + beamAxis] = beam
      positions[vi + depthAxis] = depth
    }
  }

  // Generate triangle indices (quad strip between adjacent sections)
  const triangleCount = (nSec - 1) * nPts * 2
  const indices = new Uint32Array(triangleCount * 3)
  let idx = 0

  for (let s = 0; s < nSec - 1; s++) {
    for (let p = 0; p < nPts; p++) {
      const p1 = p
      const p2 = (p + 1) % nPts
      const a = s * nPts + p1
      const b = s * nPts + p2
      const c = (s + 1) * nPts + p2
      const d = (s + 1) * nPts + p1

      indices[idx++] = a; indices[idx++] = b; indices[idx++] = c
      indices[idx++] = a; indices[idx++] = c; indices[idx++] = d
    }
  }

  return { positions, indices, vertexCount, triangleCount }
}

// ---------------------------------------------------------------------------
// Resample contour to N evenly-spaced points
// ---------------------------------------------------------------------------

function resampleContour(contour: Float32Array, n: number): Float32Array {
  const nPts = contour.length / 2
  if (nPts < 3) return new Float32Array(n * 2)

  // Compute center
  let cx = 0, cy = 0
  for (let i = 0; i < nPts; i++) {
    cx += contour[i * 2]!
    cy += contour[i * 2 + 1]!
  }
  cx /= nPts; cy /= nPts

  // Sort by angle
  const angles: Array<{ angle: number, x: number, y: number }> = []
  for (let i = 0; i < nPts; i++) {
    const x = contour[i * 2]! - cx
    const y = contour[i * 2 + 1]! - cy
    angles.push({ angle: Math.atan2(y, x), x: contour[i * 2]!, y: contour[i * 2 + 1]! })
  }
  angles.sort((a, b) => a.angle - b.angle)

  // Interpolate to N uniform angular positions
  const result = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const targetAngle = -Math.PI + (2 * Math.PI * i) / n
    // Find closest
    let best = 0
    let bestDiff = Infinity
    for (let j = 0; j < angles.length; j++) {
      let diff = Math.abs(angles[j]!.angle - targetAngle)
      if (diff > Math.PI) diff = 2 * Math.PI - diff
      if (diff < bestDiff) { bestDiff = diff; best = j }
    }
    result[i * 2] = angles[best]!.x
    result[i * 2 + 1] = angles[best]!.y
  }

  return result
}
