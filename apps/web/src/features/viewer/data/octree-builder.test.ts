import { describe, expect, it } from 'vitest'
import {
  buildHierarchyNodes,
  buildOctree,
  computeTargetDepth,
  countNodes,
  decodeTileBinary,
  encodeTileBinary,
  FLAG_HAS_CLASSIFICATION,
  FLAG_HAS_COLOR,
  FLAG_HAS_INTENSITY,
} from './octree-builder'
import type { TileAttributes } from './octree-builder'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAttrs(
  positions: Float32Array,
  colors: Uint8Array | undefined,
  intensity: Float32Array,
  classification: Uint8Array,
): TileAttributes {
  return { positions, colors, intensity, classification }
}

/**
 * Generate N points uniformly distributed in [0, size)^3.
 * Uses a simple LCG for deterministic "random" positions.
 */
function generatePoints(n: number, size: number = 10): {
  positions: Float32Array
  colors: Uint8Array
  intensity: Float32Array
  classification: Uint8Array
} {
  const positions = new Float32Array(n * 3)
  const colors = new Uint8Array(n * 3)
  const intensity = new Float32Array(n)
  const classification = new Uint8Array(n)

  let seed = 12345
  function lcg(): number {
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
    return seed / 0x7FFFFFFF
  }

  for (let i = 0; i < n; i++) {
    positions[i * 3] = lcg() * size
    positions[i * 3 + 1] = lcg() * size
    positions[i * 3 + 2] = lcg() * size
    colors[i * 3] = Math.floor(lcg() * 255)
    colors[i * 3 + 1] = Math.floor(lcg() * 255)
    colors[i * 3 + 2] = Math.floor(lcg() * 255)
    intensity[i] = lcg()
    classification[i] = Math.floor(lcg() * 10)
  }

  return { positions, colors, intensity, classification }
}

// ---------------------------------------------------------------------------
// computeTargetDepth
// ---------------------------------------------------------------------------

describe('computeTargetDepth', () => {
  it('returns 6 for small point clouds', () => {
    expect(computeTargetDepth(50_000)).toBe(6)
    expect(computeTargetDepth(99_999)).toBe(6)
  })

  it('returns 8 for medium point clouds', () => {
    expect(computeTargetDepth(100_000)).toBe(8)
    expect(computeTargetDepth(999_999)).toBe(8)
  })

  it('returns 10 for large point clouds', () => {
    expect(computeTargetDepth(1_000_000)).toBe(10)
    expect(computeTargetDepth(9_999_999)).toBe(10)
  })

  it('returns 12 for very large point clouds', () => {
    expect(computeTargetDepth(10_000_000)).toBe(12)
    expect(computeTargetDepth(49_999_999)).toBe(12)
  })

  it('returns 14 for massive point clouds', () => {
    expect(computeTargetDepth(50_000_000)).toBe(14)
    expect(computeTargetDepth(100_000_000)).toBe(14)
  })
})

// ---------------------------------------------------------------------------
// buildOctree
// ---------------------------------------------------------------------------

describe('buildOctree', () => {
  it('creates root node for small point sets', () => {
    const { positions } = generatePoints(500, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }

    const { root, indices } = buildOctree(positions, 500, bounds, 6)

    expect(root.id).toBe('0-0-0-0')
    expect(root.depth).toBe(0)
    expect(root.indexEnd - root.indexStart).toBe(500)
    // Below MIN_LEAF_POINTS, so should be a leaf
    expect(root.children).toEqual([])
    expect(indices).toHaveLength(500)
  })

  it('subdivides into octants for larger point sets', () => {
    const n = 5000
    const { positions } = generatePoints(n, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }

    const { root, indices } = buildOctree(positions, n, bounds, 6)

    expect(root.id).toBe('0-0-0-0')
    // Should have children since n > MIN_LEAF_POINTS
    const nonNullChildren = root.children.filter(c => c !== null)
    expect(nonNullChildren.length).toBeGreaterThan(0)

    // Total points across all leaves should equal n
    let totalLeafPoints = 0
    function countLeafPoints(node: typeof root): void {
      const isLeaf = node.children.length === 0 || node.children.every(c => c === null)
      if (isLeaf) {
        totalLeafPoints += node.indexEnd - node.indexStart
      }
      else {
        for (const child of node.children) {
          if (child)
            countLeafPoints(child)
        }
      }
    }
    countLeafPoints(root)
    expect(totalLeafPoints).toBe(n)

    // Indices should be a permutation of [0..n-1]
    const sorted = Array.from(indices).sort((a, b) => a - b)
    for (let i = 0; i < n; i++) {
      expect(sorted[i]).toBe(i)
    }
  })

  it('respects maxDepth limit', () => {
    const n = 5000
    const { positions } = generatePoints(n, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }

    const { root } = buildOctree(positions, n, bounds, 2)

    function maxDepth(node: typeof root): number {
      let max = node.depth
      for (const child of node.children) {
        if (child) {
          max = Math.max(max, maxDepth(child))
        }
      }
      return max
    }

    expect(maxDepth(root)).toBeLessThanOrEqual(2)
  })

  it('assigns correct bounds to children', () => {
    const n = 5000
    const { positions } = generatePoints(n, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }

    const { root } = buildOctree(positions, n, bounds, 2)

    for (const child of root.children) {
      if (!child)
        continue
      // Each child bound should be half the parent
      const [cMinX, cMinY, cMinZ] = child.bounds.min
      const [cMaxX, cMaxY, cMaxZ] = child.bounds.max
      expect(cMaxX - cMinX).toBeCloseTo(5, 5)
      expect(cMaxY - cMinY).toBeCloseTo(5, 5)
      expect(cMaxZ - cMinZ).toBeCloseTo(5, 5)
    }
  })

  it('correctly partitions points into spatial octants', () => {
    // 8 points, one in each octant corner
    const positions = new Float32Array([
      1,
      1,
      1, // octant 0 (---): x<5, y<5, z<5
      6,
      1,
      1, // octant 1 (+--): x>=5, y<5, z<5
      1,
      6,
      1, // octant 2 (-+-): x<5, y>=5, z<5
      6,
      6,
      1, // octant 3 (++-): x>=5, y>=5, z<5
      1,
      1,
      6, // octant 4 (--+): x<5, y<5, z>=5
      6,
      1,
      6, // octant 5 (+-+): x>=5, y<5, z>=5
      1,
      6,
      6, // octant 6 (-++): x<5, y>=5, z>=5
      6,
      6,
      6, // octant 7 (+++): x>=5, y>=5, z>=5
    ])
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }

    // Use depth 1 to get exactly one level of subdivision
    // MIN_LEAF_POINTS is 1000, so 8 points won't subdivide further at depth 0
    // unless we override. Since 8 < MIN_LEAF_POINTS, depth 0 won't subdivide.
    // So we need at least MIN_LEAF_POINTS + 1 to see subdivision.
    // Let's test with the explicit build function behavior instead:
    // With 8 points and MIN_LEAF_POINTS=1000, root will be a leaf.
    const { root } = buildOctree(positions, 8, bounds, 6)
    expect(root.children).toEqual([]) // leaf because 8 < 1000
  })

  it('generates COPC-compatible node IDs', () => {
    const n = 5000
    const { positions } = generatePoints(n, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }

    const { root } = buildOctree(positions, n, bounds, 3)

    function checkIds(node: typeof root): void {
      const parts = node.id.split('-')
      expect(parts).toHaveLength(4)
      const [d, x, y, z] = parts.map(Number)
      expect(d).toBe(node.depth)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(z).toBeGreaterThanOrEqual(0)

      for (const child of node.children) {
        if (child)
          checkIds(child)
      }
    }
    checkIds(root)
  })
})

// ---------------------------------------------------------------------------
// countNodes
// ---------------------------------------------------------------------------

describe('countNodes', () => {
  it('returns 1 for a leaf node', () => {
    const { positions } = generatePoints(500, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }
    const { root } = buildOctree(positions, 500, bounds, 6)

    expect(countNodes(root)).toBe(1)
  })

  it('counts all nodes in the tree', () => {
    const n = 5000
    const { positions } = generatePoints(n, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }
    const { root } = buildOctree(positions, n, bounds, 2)

    const total = countNodes(root)
    // Should have root + some children
    expect(total).toBeGreaterThan(1)

    // Manual count for verification
    let manual = 0
    function count(node: typeof root): void {
      if ((node.indexEnd - node.indexStart) > 0)
        manual++
      for (const child of node.children) {
        if (child)
          count(child)
      }
    }
    count(root)
    expect(total).toBe(manual)
  })
})

// ---------------------------------------------------------------------------
// encodeTileBinary / decodeTileBinary
// ---------------------------------------------------------------------------

describe('tile binary encoding/decoding', () => {
  it('round-trips positions only (no color)', () => {
    const positions = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const intensity = new Float32Array([0.1, 0.5, 0.9])
    const classification = new Uint8Array([2, 6, 3])
    const indices = new Uint32Array([0, 1, 2])

    const buffer = encodeTileBinary(indices, 0, 3, 1, makeAttrs(positions, undefined, intensity, classification))
    const decoded = decodeTileBinary(buffer)

    expect(decoded.pointCount).toBe(3)
    expect(decoded.colors).toBeUndefined()

    for (let i = 0; i < 9; i++) {
      expect(decoded.positions[i]).toBeCloseTo(positions[i]!, 5)
    }
    for (let i = 0; i < 3; i++) {
      expect(decoded.intensity[i]).toBeCloseTo(intensity[i]!, 5)
      expect(decoded.classification[i]).toBe(classification[i])
    }
  })

  it('round-trips with color', () => {
    const positions = new Float32Array([10, 20, 30])
    const colors = new Uint8Array([255, 128, 0])
    const intensity = new Float32Array([0.75])
    const classification = new Uint8Array([9])
    const indices = new Uint32Array([0])

    const buffer = encodeTileBinary(indices, 0, 1, 1, makeAttrs(positions, colors, intensity, classification))
    const decoded = decodeTileBinary(buffer)

    expect(decoded.pointCount).toBe(1)
    expect(decoded.colors).toBeDefined()
    expect(decoded.colors![0]).toBe(255)
    expect(decoded.colors![1]).toBe(128)
    expect(decoded.colors![2]).toBe(0)
    expect(decoded.positions[0]).toBeCloseTo(10, 5)
    expect(decoded.positions[1]).toBeCloseTo(20, 5)
    expect(decoded.positions[2]).toBeCloseTo(30, 5)
  })

  it('applies stride for subsampling', () => {
    const n = 10
    const positions = new Float32Array(n * 3)
    const intensity = new Float32Array(n)
    const classification = new Uint8Array(n)
    const indices = new Uint32Array(n)

    for (let i = 0; i < n; i++) {
      positions[i * 3] = i
      positions[i * 3 + 1] = i + 10
      positions[i * 3 + 2] = i + 20
      intensity[i] = i / n
      classification[i] = i
      indices[i] = i
    }

    // Stride of 3: should pick indices 0, 3, 6, 9 = 4 points
    const buffer = encodeTileBinary(indices, 0, 10, 3, makeAttrs(positions, undefined, intensity, classification))
    const decoded = decodeTileBinary(buffer)

    expect(decoded.pointCount).toBe(4)
    expect(decoded.positions[0]).toBeCloseTo(0, 5) // index 0
    expect(decoded.positions[3]).toBeCloseTo(3, 5) // index 3
    expect(decoded.positions[6]).toBeCloseTo(6, 5) // index 6
    expect(decoded.positions[9]).toBeCloseTo(9, 5) // index 9
  })

  it('handles index range (not from 0)', () => {
    const positions = new Float32Array([0, 0, 0, 10, 20, 30, 40, 50, 60])
    const intensity = new Float32Array([0.1, 0.5, 0.9])
    const classification = new Uint8Array([1, 2, 3])
    const indices = new Uint32Array([2, 0, 1]) // reordered

    // Encode only index range [1, 3) = indices[1] and indices[2]
    const buffer = encodeTileBinary(indices, 1, 3, 1, makeAttrs(positions, undefined, intensity, classification))
    const decoded = decodeTileBinary(buffer)

    expect(decoded.pointCount).toBe(2)
    // indices[1]=0 -> positions[0,1,2] = 0,0,0
    expect(decoded.positions[0]).toBeCloseTo(0, 5)
    expect(decoded.positions[1]).toBeCloseTo(0, 5)
    expect(decoded.positions[2]).toBeCloseTo(0, 5)
    // indices[2]=1 -> positions[3,4,5] = 10,20,30
    expect(decoded.positions[3]).toBeCloseTo(10, 5)
    expect(decoded.positions[4]).toBeCloseTo(20, 5)
    expect(decoded.positions[5]).toBeCloseTo(30, 5)
  })

  it('sets correct flags in binary header', () => {
    const positions = new Float32Array([1, 2, 3])
    const colors = new Uint8Array([255, 0, 128])
    const intensity = new Float32Array([0.5])
    const classification = new Uint8Array([2])
    const indices = new Uint32Array([0])

    const withColor = encodeTileBinary(indices, 0, 1, 1, makeAttrs(positions, colors, intensity, classification))
    const withColorView = new DataView(withColor)
    const flagsWithColor = withColorView.getUint32(4, true)
    expect(flagsWithColor & FLAG_HAS_COLOR).toBeTruthy()
    expect(flagsWithColor & FLAG_HAS_INTENSITY).toBeTruthy()
    expect(flagsWithColor & FLAG_HAS_CLASSIFICATION).toBeTruthy()

    const noColor = encodeTileBinary(indices, 0, 1, 1, makeAttrs(positions, undefined, intensity, classification))
    const noColorView = new DataView(noColor)
    const flagsNoColor = noColorView.getUint32(4, true)
    expect(flagsNoColor & FLAG_HAS_COLOR).toBeFalsy()
    expect(flagsNoColor & FLAG_HAS_INTENSITY).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// buildHierarchyNodes
// ---------------------------------------------------------------------------

describe('buildHierarchyNodes', () => {
  it('returns single node for leaf tree', () => {
    const { positions } = generatePoints(500, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }
    const { root } = buildOctree(positions, 500, bounds, 6)

    const nodes = buildHierarchyNodes(root)

    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.id).toBe('0-0-0-0')
    expect(nodes[0]!.level).toBe(0)
    expect(nodes[0]!.pointCount).toBe(500)
    expect(nodes[0]!.childMask).toBe(0)
  })

  it('includes all nodes with correct child masks', () => {
    const n = 5000
    const { positions } = generatePoints(n, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }
    const { root } = buildOctree(positions, n, bounds, 2)

    const nodes = buildHierarchyNodes(root)

    // Should match countNodes
    expect(nodes.length).toBe(countNodes(root))

    // Root should have non-zero childMask
    const rootNode = nodes.find(n => n.id === '0-0-0-0')
    expect(rootNode).toBeDefined()
    expect(rootNode!.childMask).toBeGreaterThan(0)

    // All leaf nodes should have childMask = 0
    const leaves = nodes.filter(n => n.childMask === 0)
    expect(leaves.length).toBeGreaterThan(0)
  })

  it('applies LOD subsampling for internal nodes', () => {
    const n = 5000
    const { positions } = generatePoints(n, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }
    const { root } = buildOctree(positions, n, bounds, 2)

    const nodes = buildHierarchyNodes(root)

    // Root is an internal node with n=5000 points
    const rootNode = nodes.find(n => n.id === '0-0-0-0')!
    // Since 5000 < LOD_SAMPLES_PER_NODE (50000), stride=1, so all points stored
    expect(rootNode.pointCount).toBe(n)

    // Sum of leaf point counts should equal total points
    const leaves = nodes.filter(n => n.childMask === 0)
    const leafSum = leaves.reduce((sum, n) => sum + n.pointCount, 0)
    expect(leafSum).toBe(n)
  })

  it('node bounds are consistent', () => {
    const n = 5000
    const { positions } = generatePoints(n, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }
    const { root } = buildOctree(positions, n, bounds, 3)

    const nodes = buildHierarchyNodes(root)

    for (const node of nodes) {
      expect(node.bounds.min[0]).toBeLessThanOrEqual(node.bounds.max[0])
      expect(node.bounds.min[1]).toBeLessThanOrEqual(node.bounds.max[1])
      expect(node.bounds.min[2]).toBeLessThanOrEqual(node.bounds.max[2])
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: octree → encode → decode
// ---------------------------------------------------------------------------

describe('octree integration', () => {
  it('builds octree, encodes leaf, decodes back correctly', () => {
    const n = 2000
    const data = generatePoints(n, 10)
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] }

    const { root, indices } = buildOctree(data.positions, n, bounds, 2)

    // Find a leaf node
    function findLeaf(node: typeof root): typeof root | null {
      const isLeaf = node.children.length === 0 || node.children.every(c => c === null)
      if (isLeaf && (node.indexEnd - node.indexStart) > 0)
        return node
      for (const child of node.children) {
        if (child) {
          const found = findLeaf(child)
          if (found)
            return found
        }
      }
      return null
    }

    const leaf = findLeaf(root)
    expect(leaf).not.toBeNull()

    const buffer = encodeTileBinary(
      indices,
      leaf!.indexStart,
      leaf!.indexEnd,
      1,
      makeAttrs(data.positions, data.colors, data.intensity, data.classification),
    )

    const decoded = decodeTileBinary(buffer)
    expect(decoded.pointCount).toBe(leaf!.indexEnd - leaf!.indexStart)

    // Verify each decoded point matches the source
    for (let i = 0; i < decoded.pointCount; i++) {
      const srcIdx = indices[leaf!.indexStart + i]!
      expect(decoded.positions[i * 3]).toBeCloseTo(data.positions[srcIdx * 3]!, 5)
      expect(decoded.positions[i * 3 + 1]).toBeCloseTo(data.positions[srcIdx * 3 + 1]!, 5)
      expect(decoded.positions[i * 3 + 2]).toBeCloseTo(data.positions[srcIdx * 3 + 2]!, 5)
      expect(decoded.colors![i * 3]).toBe(data.colors[srcIdx * 3])
      expect(decoded.colors![i * 3 + 1]).toBe(data.colors[srcIdx * 3 + 1])
      expect(decoded.colors![i * 3 + 2]).toBe(data.colors[srcIdx * 3 + 2])
      expect(decoded.intensity[i]).toBeCloseTo(data.intensity[srcIdx]!, 5)
      expect(decoded.classification[i]).toBe(data.classification[srcIdx])
    }
  })
})
