/**
 * Octree construction from flat point arrays.
 *
 * Pure computation — no Worker/OPFS dependencies. Testable in isolation.
 */

import type { Bounds, OctreeNode } from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_LEAF_POINTS = 1000
export const LOD_SAMPLES_PER_NODE = 50_000

// Tile binary format flags
export const FLAG_HAS_COLOR = 1
export const FLAG_HAS_INTENSITY = 2
export const FLAG_HAS_CLASSIFICATION = 4

// ---------------------------------------------------------------------------
// Target depth heuristic
// ---------------------------------------------------------------------------

export function computeTargetDepth(pointCount: number): number {
  if (pointCount < 100_000)
    return 6
  if (pointCount < 1_000_000)
    return 8
  if (pointCount < 10_000_000)
    return 10
  if (pointCount < 50_000_000)
    return 12
  return 14
}

// ---------------------------------------------------------------------------
// Builder node (internal representation during construction)
// ---------------------------------------------------------------------------

export interface BuilderNode {
  id: string
  depth: number
  bounds: Bounds
  indexStart: number
  indexEnd: number // exclusive
  children: (BuilderNode | null)[]
}

// ---------------------------------------------------------------------------
// Octree construction via spatial sorting
// ---------------------------------------------------------------------------

export function buildOctree(
  positions: Float32Array,
  pointCount: number,
  bounds: Bounds,
  targetDepth: number,
): { root: BuilderNode, indices: Uint32Array } {
  const indices = new Uint32Array(pointCount)
  for (let i = 0; i < pointCount; i++) {
    indices[i] = i
  }

  const root: BuilderNode = {
    id: '0-0-0-0',
    depth: 0,
    bounds,
    indexStart: 0,
    indexEnd: pointCount,
    children: [],
  }

  subdivide(root, indices, positions, targetDepth)
  return { root, indices }
}

function subdivide(
  node: BuilderNode,
  indices: Uint32Array,
  positions: Float32Array,
  maxDepth: number,
): void {
  const count = node.indexEnd - node.indexStart

  if (node.depth >= maxDepth || count <= MIN_LEAF_POINTS) {
    node.children = []
    return
  }

  const { min, max } = node.bounds
  const midX = (min[0] + max[0]) * 0.5
  const midY = (min[1] + max[1]) * 0.5
  const midZ = (min[2] + max[2]) * 0.5

  const start = node.indexStart
  const end = node.indexEnd

  // Count points per octant
  const octantCounts = new Int32Array(8)
  for (let i = start; i < end; i++) {
    const idx = indices[i]!
    const octant
      = (positions[idx * 3]! >= midX ? 1 : 0)
        | (positions[idx * 3 + 1]! >= midY ? 2 : 0)
        | (positions[idx * 3 + 2]! >= midZ ? 4 : 0)
    octantCounts[octant]++
  }

  // Prefix sums for octant start positions
  const octantStarts = new Int32Array(8)
  const octantPositions = new Int32Array(8)
  let offset = start
  for (let o = 0; o < 8; o++) {
    octantStarts[o] = offset
    octantPositions[o] = offset
    offset += octantCounts[o]!
  }

  // Distribute indices into octant order via temp buffer
  const tempIndices = new Uint32Array(count)
  for (let i = start; i < end; i++) {
    const idx = indices[i]!
    const octant
      = (positions[idx * 3]! >= midX ? 1 : 0)
        | (positions[idx * 3 + 1]! >= midY ? 2 : 0)
        | (positions[idx * 3 + 2]! >= midZ ? 4 : 0)
    tempIndices[octantPositions[octant]! - start] = idx
    octantPositions[octant]++
  }
  indices.set(tempIndices, start)

  // Parse parent key
  const parts = node.id.split('-')
  const parentX = Number.parseInt(parts[1]!, 10)
  const parentY = Number.parseInt(parts[2]!, 10)
  const parentZ = Number.parseInt(parts[3]!, 10)

  node.children = Array.from({ length: 8 }).fill(null) as (BuilderNode | null)[]
  const childDepth = node.depth + 1

  for (let o = 0; o < 8; o++) {
    const childCount = octantCounts[o]!
    if (childCount === 0)
      continue

    const childX = parentX * 2 + (o & 1)
    const childY = parentY * 2 + ((o >> 1) & 1)
    const childZ = parentZ * 2 + ((o >> 2) & 1)

    const childBounds: Bounds = {
      min: [
        (o & 1) ? midX : min[0],
        (o & 2) ? midY : min[1],
        (o & 4) ? midZ : min[2],
      ],
      max: [
        (o & 1) ? max[0] : midX,
        (o & 2) ? max[1] : midY,
        (o & 4) ? max[2] : midZ,
      ],
    }

    const child: BuilderNode = {
      id: `${childDepth}-${childX}-${childY}-${childZ}`,
      depth: childDepth,
      bounds: childBounds,
      indexStart: octantStarts[o]!,
      indexEnd: octantStarts[o]! + childCount,
      children: [],
    }

    node.children[o] = child
    subdivide(child, indices, positions, maxDepth)
  }
}

// ---------------------------------------------------------------------------
// Tile binary encoding
// ---------------------------------------------------------------------------

export function encodeTileBinary(
  indices: Uint32Array,
  indexStart: number,
  indexEnd: number,
  stride: number,
  positions: Float32Array,
  colors: Uint8Array | undefined,
  intensity: Float32Array,
  classification: Uint8Array,
): ArrayBuffer {
  let pointCount = 0
  for (let i = indexStart; i < indexEnd; i += stride) {
    pointCount++
  }

  let flags = 0
  if (colors)
    flags |= FLAG_HAS_COLOR
  flags |= FLAG_HAS_INTENSITY
  flags |= FLAG_HAS_CLASSIFICATION

  const headerSize = 8
  let size = headerSize + pointCount * 12
  if (colors)
    size += pointCount * 3
  size += pointCount * 4 // intensity
  size += pointCount // classification

  const buffer = new ArrayBuffer(size)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  view.setUint32(0, pointCount, true)
  view.setUint32(4, flags, true)

  // Positions
  let off = headerSize
  for (let i = indexStart; i < indexEnd; i += stride) {
    const srcIdx = indices[i]!
    const srcOff = srcIdx * 3
    view.setFloat32(off, positions[srcOff]!, true)
    view.setFloat32(off + 4, positions[srcOff + 1]!, true)
    view.setFloat32(off + 8, positions[srcOff + 2]!, true)
    off += 12
  }

  // Colors
  if (colors) {
    for (let i = indexStart; i < indexEnd; i += stride) {
      const srcIdx = indices[i]!
      const srcOff = srcIdx * 3
      bytes[off] = colors[srcOff]!
      bytes[off + 1] = colors[srcOff + 1]!
      bytes[off + 2] = colors[srcOff + 2]!
      off += 3
    }
  }

  // Intensity
  for (let i = indexStart; i < indexEnd; i += stride) {
    const srcIdx = indices[i]!
    view.setFloat32(off, intensity[srcIdx]!, true)
    off += 4
  }

  // Classification
  for (let i = indexStart; i < indexEnd; i += stride) {
    const srcIdx = indices[i]!
    bytes[off] = classification[srcIdx]!
    off++
  }

  return buffer
}

// ---------------------------------------------------------------------------
// Decode tile binary back to typed arrays (for reading from cache)
// ---------------------------------------------------------------------------

export interface DecodedTile {
  pointCount: number
  positions: Float32Array
  colors: Uint8Array | undefined
  intensity: Float32Array
  classification: Uint8Array
}

export function decodeTileBinary(buffer: ArrayBuffer): DecodedTile {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  const pointCount = view.getUint32(0, true)
  const flags = view.getUint32(4, true)

  const hasColor = (flags & FLAG_HAS_COLOR) !== 0
  const hasIntensity = (flags & FLAG_HAS_INTENSITY) !== 0
  const hasClassification = (flags & FLAG_HAS_CLASSIFICATION) !== 0

  let off = 8

  // Positions
  const positions = new Float32Array(pointCount * 3)
  for (let i = 0; i < pointCount; i++) {
    positions[i * 3] = view.getFloat32(off, true)
    positions[i * 3 + 1] = view.getFloat32(off + 4, true)
    positions[i * 3 + 2] = view.getFloat32(off + 8, true)
    off += 12
  }

  // Colors
  let colors: Uint8Array | undefined
  if (hasColor) {
    colors = new Uint8Array(pointCount * 3)
    colors.set(bytes.subarray(off, off + pointCount * 3))
    off += pointCount * 3
  }

  // Intensity
  const intensity = new Float32Array(pointCount)
  if (hasIntensity) {
    for (let i = 0; i < pointCount; i++) {
      intensity[i] = view.getFloat32(off, true)
      off += 4
    }
  }

  // Classification
  const classification = new Uint8Array(pointCount)
  if (hasClassification) {
    classification.set(bytes.subarray(off, off + pointCount))
  }

  return { pointCount, positions, colors, intensity, classification }
}

// ---------------------------------------------------------------------------
// Build hierarchy metadata from BuilderNode tree
// ---------------------------------------------------------------------------

export function buildHierarchyNodes(root: BuilderNode): OctreeNode[] {
  const nodes: OctreeNode[] = []
  collectNodes(root, nodes)
  return nodes
}

function collectNodes(node: BuilderNode, result: OctreeNode[]): void {
  const count = node.indexEnd - node.indexStart
  if (count === 0)
    return

  const isLeaf = node.children.length === 0
    || node.children.every(c => c === null)
  const stride = isLeaf
    ? 1
    : Math.max(1, Math.floor(count / LOD_SAMPLES_PER_NODE))

  let storedCount = 0
  for (let i = node.indexStart; i < node.indexEnd; i += stride) {
    storedCount++
  }

  let childMask = 0
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (child && (child.indexEnd - child.indexStart) > 0) {
      childMask |= 1 << i
    }
  }

  result.push({
    id: node.id,
    level: node.depth,
    bounds: node.bounds,
    pointCount: storedCount,
    childMask,
    byteOffset: 0,
    byteSize: 0,
  })

  for (const child of node.children) {
    if (child) {
      collectNodes(child, result)
    }
  }
}

// ---------------------------------------------------------------------------
// Count total nodes in tree
// ---------------------------------------------------------------------------

export function countNodes(node: BuilderNode): number {
  const count = node.indexEnd - node.indexStart
  if (count === 0)
    return 0

  let total = 1
  for (const child of node.children) {
    if (child)
      total += countNodes(child)
  }
  return total
}
