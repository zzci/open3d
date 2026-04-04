import type { OctreeNode } from './types'
import { Key } from 'copc'

/**
 * COPC octree child ordering: 8 children indexed by (z, y, x) bits.
 * Child i occupies the octant where:
 *   x-bit = (i >> 0) & 1
 *   y-bit = (i >> 1) & 1
 *   z-bit = (i >> 2) & 1
 */
const CHILD_STEPS: Array<[number, number, number]> = [
  [0, 0, 0], // 0
  [1, 0, 0], // 1
  [0, 1, 0], // 2
  [1, 1, 0], // 3
  [0, 0, 1], // 4
  [1, 0, 1], // 5
  [0, 1, 1], // 6
  [1, 1, 1], // 7
]

/**
 * Compute childMask for every node in the hierarchy map.
 * A node's childMask is a bitmask (0-255) indicating which of its 8
 * potential children actually exist in the hierarchy.
 *
 * Mutates nodes in place for efficiency (called once during hierarchy build).
 */
export function computeChildMask(nodes: Map<string, OctreeNode>): void {
  for (const node of nodes.values()) {
    let mask = 0
    const parentKey = Key.create(node.id)
    const childDepth = parentKey[0] + 1

    for (let i = 0; i < 8; i++) {
      const [dx, dy, dz] = CHILD_STEPS[i]
      const childX = parentKey[1] * 2 + dx
      const childY = parentKey[2] * 2 + dy
      const childZ = parentKey[3] * 2 + dz
      const childId = `${childDepth}-${childX}-${childY}-${childZ}`

      if (nodes.has(childId)) {
        mask |= 1 << i
      }
    }

    node.childMask = mask
  }
}

/**
 * Get the IDs of all existing children for a given node.
 */
export function getChildIds(node: OctreeNode): string[] {
  if (node.childMask === 0)
    return []

  const parentKey = Key.create(node.id)
  const childDepth = parentKey[0] + 1
  const ids: string[] = []

  for (let i = 0; i < 8; i++) {
    if ((node.childMask & (1 << i)) === 0)
      continue
    const [dx, dy, dz] = CHILD_STEPS[i]
    const childX = parentKey[1] * 2 + dx
    const childY = parentKey[2] * 2 + dy
    const childZ = parentKey[3] * 2 + dz
    ids.push(`${childDepth}-${childX}-${childY}-${childZ}`)
  }

  return ids
}

/**
 * Check if a node is a leaf (has no children).
 */
export function isLeaf(node: OctreeNode): boolean {
  return node.childMask === 0
}

/**
 * Serialize hierarchy map to a transferable array of OctreeNodes.
 * Used to pass hierarchy from worker to main thread.
 */
export function serializeHierarchy(nodes: Map<string, OctreeNode>): OctreeNode[] {
  return Array.from(nodes.values())
}

/**
 * Deserialize an array of OctreeNodes back to a Map.
 */
export function deserializeHierarchy(nodes: OctreeNode[]): Map<string, OctreeNode> {
  const map = new Map<string, OctreeNode>()
  for (const node of nodes) {
    map.set(node.id, node)
  }
  return map
}
