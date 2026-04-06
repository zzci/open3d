/**
 * Interior structure detection — separates fixed structure from furniture.
 *
 * Algorithm:
 * 1. RANSAC finds dominant planes (floor, ceiling, walls)
 * 2. Points near any major plane = structure
 * 3. Points far from all planes = furniture/movable objects
 *
 * Core rule: in a ship cabin, nothing structural is free-floating.
 */

// ---------------------------------------------------------------------------
// RANSAC plane fitting
// ---------------------------------------------------------------------------

export interface Plane {
  normal: [number, number, number] // unit normal
  d: number                        // signed distance from origin
  type: 'floor' | 'ceiling' | 'wall' | 'angled'
  inlierCount: number
}

/**
 * Fit a plane using RANSAC. Returns the best plane or null.
 */
function ransacPlane(
  positions: Float32Array,
  indices: number[],
  distThreshold: number,
  iterations: number,
): { plane: [number, number, number, number], inliers: number[] } | null {
  if (indices.length < 3) return null

  let bestPlane: [number, number, number, number] = [0, 0, 0, 0]
  let bestInliers: number[] = []

  for (let iter = 0; iter < iterations; iter++) {
    // Pick 3 random points
    const i0 = indices[Math.floor(Math.random() * indices.length)]!
    const i1 = indices[Math.floor(Math.random() * indices.length)]!
    const i2 = indices[Math.floor(Math.random() * indices.length)]!
    if (i0 === i1 || i1 === i2 || i0 === i2) continue

    const ax = positions[i0 * 3]!, ay = positions[i0 * 3 + 1]!, az = positions[i0 * 3 + 2]!
    const bx = positions[i1 * 3]!, by = positions[i1 * 3 + 1]!, bz = positions[i1 * 3 + 2]!
    const cx = positions[i2 * 3]!, cy = positions[i2 * 3 + 1]!, cz = positions[i2 * 3 + 2]!

    // Cross product of two edge vectors
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (len < 1e-10) continue
    nx /= len; ny /= len; nz /= len
    const d = -(nx * ax + ny * ay + nz * az)

    // Count inliers
    const inliers: number[] = []
    for (const idx of indices) {
      const px = positions[idx * 3]!, py = positions[idx * 3 + 1]!, pz = positions[idx * 3 + 2]!
      const dist = Math.abs(nx * px + ny * py + nz * pz + d)
      if (dist < distThreshold) {
        inliers.push(idx)
      }
    }

    if (inliers.length > bestInliers.length) {
      bestInliers = inliers
      bestPlane = [nx, ny, nz, d]
    }
  }

  if (bestInliers.length < 100) return null
  return { plane: bestPlane, inliers: bestInliers }
}

// ---------------------------------------------------------------------------
// Classify plane type
// ---------------------------------------------------------------------------

function classifyPlane(
  normal: [number, number, number],
  positions: Float32Array,
  inliers: number[],
  zMean: number,
): Plane['type'] {
  const absN = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])]

  if (absN[2]! > 0.8) {
    // Horizontal plane — floor or ceiling?
    let zSum = 0
    for (const i of inliers) zSum += positions[i * 3 + 2]!
    const avgZ = zSum / inliers.length
    return avgZ < zMean ? 'floor' : 'ceiling'
  }

  if (absN[2]! < 0.3) {
    return 'wall'
  }

  return 'angled'
}

// ---------------------------------------------------------------------------
// Main detection
// ---------------------------------------------------------------------------

export interface StructureResult {
  planes: Plane[]
  structureMask: Uint8Array  // 1 = structure, 0 = furniture/unknown
  structureCount: number
  furnitureCount: number
}

export function detectStructure(
  positions: Float32Array,
  count: number,
  options: {
    maxPlanes?: number
    distThreshold?: number     // meters, how close to plane = inlier
    structureDistance?: number  // meters, how close to any plane = structure
    ransacIterations?: number
    minPlanePercent?: number   // minimum % of remaining points for a valid plane
  } = {},
): StructureResult {
  const {
    maxPlanes = 10,
    distThreshold = 0.02,       // 2cm for plane fitting
    structureDistance = 0.15,    // 15cm from any plane = structure
    ransacIterations = 1000,
    minPlanePercent = 1,
  } = options

  // Compute mean Z for floor/ceiling classification
  let zSum = 0
  const step = Math.max(1, Math.floor(count / 10000))
  let n = 0
  for (let i = 0; i < count; i += step) { zSum += positions[i * 3 + 2]!; n++ }
  const zMean = zSum / n

  // Detect planes iteratively
  const planes: Plane[] = []
  let remaining = Array.from({ length: count }, (_, i) => i)
  const minPlanePts = Math.floor(count * minPlanePercent / 100)

  for (let p = 0; p < maxPlanes; p++) {
    if (remaining.length < minPlanePts) break

    const result = ransacPlane(positions, remaining, distThreshold, ransacIterations)
    if (!result || result.inliers.length < minPlanePts) break

    const [nx, ny, nz, d] = result.plane
    const normal: [number, number, number] = [nx!, ny!, nz!]
    const type = classifyPlane(normal, positions, result.inliers, zMean)

    planes.push({ normal, d: d!, type, inlierCount: result.inliers.length })

    // Remove inliers from remaining
    const inlierSet = new Set(result.inliers)
    remaining = remaining.filter(i => !inlierSet.has(i))
  }

  // Classify all points: structure = within structureDistance of any plane
  const structureMask = new Uint8Array(count)
  let structureCount = 0

  for (let i = 0; i < count; i++) {
    const px = positions[i * 3]!, py = positions[i * 3 + 1]!, pz = positions[i * 3 + 2]!

    for (const plane of planes) {
      const dist = Math.abs(plane.normal[0] * px + plane.normal[1] * py + plane.normal[2] * pz + plane.d)
      if (dist < structureDistance) {
        structureMask[i] = 1
        structureCount++
        break
      }
    }
  }

  return {
    planes,
    structureMask,
    structureCount,
    furnitureCount: count - structureCount,
  }
}
