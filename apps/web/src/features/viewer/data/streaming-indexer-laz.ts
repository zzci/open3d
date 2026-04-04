/**
 * LAZ-optimized streaming indexer.
 *
 * LAZ files require sequential decompression — random File.slice() won't
 * work. This module uses a two-pass strategy:
 *
 *   Pass 1 (counting): decompress once, classify every point into its
 *           leaf-level octant using Morton code → build the complete
 *           octant count tree in one sequential pass.
 *
 *   Pass 2 (materialization): decompress again, write each point's full
 *           attributes directly into the correct leaf tile buffer.
 *
 * Memory for pass 1: O(8^depth) counters ≈ negligible for depth ≤ 14.
 * Memory for pass 2: O(sum of leaf sizes being flushed) — controlled by
 *   flushing completed tiles as they fill up.
 */

import type { LasHeader } from './las-reader'
import type { TileAttributes } from './octree-builder'
import type { CancelCheck, ProgressCallback, TileWriteCallback } from './streaming-indexer'
import type { Bounds, OctreeNode } from './types'
import { formatHasColor } from './las-reader'
import {
  encodeTileBinary,
  MIN_LEAF_POINTS,
} from './octree-builder'
import { childBounds, classifyOctant } from './streaming-indexer'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OctantCountNode {
  count: number
  children: (OctantCountNode | null)[]
}

interface LeafDescriptor {
  nodeId: string
  depth: number
  bounds: Bounds
  expectedCount: number
  // Write cursor during pass 2
  written: number
  // Pre-allocated buffers (allocated at pass 2 start)
  attrs: TileAttributes | null
}

// ---------------------------------------------------------------------------
// Pass 1: Single-pass Morton code counting
// ---------------------------------------------------------------------------

/**
 * Decompress the entire LAZ file once, classify each point into its
 * target leaf octant, and return the complete count tree.
 */
export async function lazCountAllLevels(
  file: File,
  header: LasHeader,
  bounds: Bounds,
  targetDepth: number,
  onProgress?: ProgressCallback,
  cancel?: CancelCheck,
): Promise<{ root: OctantCountNode, leafMap: Map<string, LeafDescriptor> }> {
  const { pointCount, pointRecordLength, offsetToPointData, scale, offset: fileOffset } = header

  // Initialize count tree
  const root: OctantCountNode = { count: 0, children: Array.from({ length: 8 }).fill(null) as null[] }

  // Single sequential decompression pass
  const compressedSize = file.size - offsetToPointData
  const compressedBuf = await file.slice(offsetToPointData, offsetToPointData + compressedSize).arrayBuffer()

  const { create } = await import('laz-perf')
  const lp = (await create()) as any

  const compressedBytes = new Uint8Array(compressedBuf)
  const srcPtr = lp._malloc(compressedBytes.length)
  lp.HEAPU8.set(compressedBytes, srcPtr)
  const pointPtr = lp._malloc(pointRecordLength)

  const decoder = new lp.LASZip()
  try {
    decoder.open(srcPtr, compressedBytes.length)

    for (let i = 0; i < pointCount; i++) {
      if (i % 500_000 === 0 && cancel?.())
        throw new Error('Cancelled')

      decoder.getPoint(pointPtr)
      const pointBytes = lp.HEAPU8.slice(pointPtr, pointPtr + pointRecordLength)
      const view = new DataView(pointBytes.buffer)

      const xi = view.getInt32(0, true)
      const yi = view.getInt32(4, true)
      const zi = view.getInt32(8, true)
      const x = xi * scale[0] + fileOffset[0]
      const y = yi * scale[1] + fileOffset[1]
      const z = zi * scale[2] + fileOffset[2]

      // Walk down the octree, creating nodes as needed
      let node = root
      let nodeBounds = bounds
      node.count++

      for (let d = 0; d < targetDepth; d++) {
        const midX = (nodeBounds.min[0] + nodeBounds.max[0]) * 0.5
        const midY = (nodeBounds.min[1] + nodeBounds.max[1]) * 0.5
        const midZ = (nodeBounds.min[2] + nodeBounds.max[2]) * 0.5
        const octant = classifyOctant(x, y, z, midX, midY, midZ)

        if (!node.children[octant]) {
          node.children[octant] = { count: 0, children: Array.from({ length: 8 }).fill(null) as null[] }
        }
        node = node.children[octant]!
        nodeBounds = childBounds(nodeBounds, octant)
        node.count++

        // Stop early if this node will be a leaf
        if (node.count <= MIN_LEAF_POINTS && d < targetDepth - 1) {
          // Can't know yet — continue counting
        }
      }

      if (i % 500_000 === 0) {
        onProgress?.({
          phase: 'counting',
          nodeId: '0-0-0-0',
          depth: 0,
          pointsScanned: i,
          totalPoints: pointCount,
          nodesCompleted: 0,
          totalNodes: 0,
        })
      }
    }
  }
  finally {
    decoder.delete()
    lp._free(pointPtr)
    lp._free(srcPtr)
  }

  // Build leaf map from count tree (prune branches where count <= MIN_LEAF_POINTS)
  const leafMap = new Map<string, LeafDescriptor>()
  collectLeaves(root, bounds, '0-0-0-0', 0, targetDepth, leafMap)

  return { root, leafMap }
}

function collectLeaves(
  node: OctantCountNode,
  nodeBounds: Bounds,
  nodeId: string,
  depth: number,
  maxDepth: number,
  leafMap: Map<string, LeafDescriptor>,
): void {
  if (node.count === 0)
    return

  const isLeaf = depth >= maxDepth
    || node.count <= MIN_LEAF_POINTS
    || node.children.every(c => c === null)

  if (isLeaf) {
    leafMap.set(nodeId, {
      nodeId,
      depth,
      bounds: nodeBounds,
      expectedCount: node.count,
      written: 0,
      attrs: null,
    })
    return
  }

  const parts = nodeId.split('-')
  const parentX = Number.parseInt(parts[1]!, 10)
  const parentY = Number.parseInt(parts[2]!, 10)
  const parentZ = Number.parseInt(parts[3]!, 10)

  for (let o = 0; o < 8; o++) {
    const child = node.children[o]
    if (!child || child.count === 0)
      continue

    const childDepth = depth + 1
    const childX = parentX * 2 + (o & 1)
    const childY = parentY * 2 + ((o >> 1) & 1)
    const childZ = parentZ * 2 + ((o >> 2) & 1)
    const childId = `${childDepth}-${childX}-${childY}-${childZ}`

    collectLeaves(child, childBounds(nodeBounds, o), childId, childDepth, maxDepth, leafMap)
  }
}

// ---------------------------------------------------------------------------
// Pass 2: Materialize leaf tiles
// ---------------------------------------------------------------------------

/**
 * Decompress the LAZ file a second time, routing each point to its
 * pre-allocated leaf tile buffer. Flush completed tiles to OPFS.
 */
export async function lazMaterializeLeaves(
  file: File,
  header: LasHeader,
  bounds: Bounds,
  targetDepth: number,
  leafMap: Map<string, LeafDescriptor>,
  writeTile: TileWriteCallback,
  onProgress?: ProgressCallback,
  cancel?: CancelCheck,
): Promise<OctreeNode[]> {
  const { pointCount, pointRecordLength, offsetToPointData, pointFormat, scale, offset: fileOffset } = header
  const hasColor = formatHasColor(pointFormat)
  const hasGpsTime = pointFormat === 1 || pointFormat === 3 || pointFormat >= 6
  const hasNir = pointFormat === 8
  const is14 = pointFormat >= 6

  // Pre-allocate leaf buffers
  for (const leaf of leafMap.values()) {
    const n = leaf.expectedCount
    leaf.attrs = {
      positions: new Float32Array(n * 3),
      colors: hasColor ? new Uint8Array(n * 3) : undefined,
      intensity: new Float32Array(n),
      classification: new Uint8Array(n),
      returnNumber: new Uint8Array(n),
      numberOfReturns: new Uint8Array(n),
      scanAngle: new Float32Array(n),
      userData: new Uint8Array(n),
      pointSourceId: new Uint16Array(n),
      gpsTime: hasGpsTime ? new Float64Array(n) : undefined,
      nir: hasNir ? new Uint16Array(n) : undefined,
      classificationFlags: is14 ? new Uint8Array(n) : undefined,
      scannerChannel: is14 ? new Uint8Array(n) : undefined,
    }
  }

  // Second decompression pass
  const compressedSize = file.size - offsetToPointData
  const compressedBuf = await file.slice(offsetToPointData, offsetToPointData + compressedSize).arrayBuffer()

  const { create } = await import('laz-perf')
  const lp = (await create()) as any

  const compressedBytes = new Uint8Array(compressedBuf)
  const srcPtr = lp._malloc(compressedBytes.length)
  lp.HEAPU8.set(compressedBytes, srcPtr)
  const pointPtr = lp._malloc(pointRecordLength)

  const hierarchy: OctreeNode[] = []
  let nodesWritten = 0

  const decoder = new lp.LASZip()
  try {
    decoder.open(srcPtr, compressedBytes.length)

    for (let i = 0; i < pointCount; i++) {
      if (i % 500_000 === 0 && cancel?.())
        throw new Error('Cancelled')

      decoder.getPoint(pointPtr)
      const pointBytes = lp.HEAPU8.slice(pointPtr, pointPtr + pointRecordLength)
      const view = new DataView(pointBytes.buffer)

      const xi = view.getInt32(0, true)
      const yi = view.getInt32(4, true)
      const zi = view.getInt32(8, true)
      const x = xi * scale[0] + fileOffset[0]
      const y = yi * scale[1] + fileOffset[1]
      const z = zi * scale[2] + fileOffset[2]

      // Find the leaf this point belongs to
      const leafId = findLeafId(x, y, z, bounds, targetDepth, leafMap)
      if (!leafId)
        continue

      const leaf = leafMap.get(leafId)!
      const a = leaf.attrs!
      const w = leaf.written

      // Write all attributes
      a.positions[w * 3] = x
      a.positions[w * 3 + 1] = y
      a.positions[w * 3 + 2] = z
      a.intensity[w] = view.getUint16(12, true) / 65535

      if (pointFormat <= 5) {
        const flagByte = view.getUint8(14)
        a.returnNumber![w] = flagByte & 0x07
        a.numberOfReturns![w] = (flagByte >> 3) & 0x07
        a.classification[w] = view.getUint8(15)
        a.scanAngle![w] = view.getInt8(16)
        a.userData![w] = view.getUint8(17)
        a.pointSourceId![w] = view.getUint16(18, true)

        if ((pointFormat === 1 || pointFormat === 3) && a.gpsTime) {
          a.gpsTime[w] = view.getFloat64(20, true)
        }
        if (pointFormat === 2 && a.colors) {
          a.colors[w * 3] = view.getUint16(20, true) >> 8
          a.colors[w * 3 + 1] = view.getUint16(22, true) >> 8
          a.colors[w * 3 + 2] = view.getUint16(24, true) >> 8
        }
        if (pointFormat === 3 && a.colors) {
          a.colors[w * 3] = view.getUint16(28, true) >> 8
          a.colors[w * 3 + 1] = view.getUint16(30, true) >> 8
          a.colors[w * 3 + 2] = view.getUint16(32, true) >> 8
        }
      }
      else {
        const flagByte = view.getUint8(14)
        a.returnNumber![w] = flagByte & 0x0F
        a.numberOfReturns![w] = (flagByte >> 4) & 0x0F
        const flagByte2 = view.getUint8(15)
        if (a.classificationFlags)
          a.classificationFlags[w] = flagByte2 & 0x0F
        if (a.scannerChannel)
          a.scannerChannel[w] = (flagByte2 >> 4) & 0x03
        a.classification[w] = view.getUint8(16)
        a.userData![w] = view.getUint8(17)
        a.scanAngle![w] = view.getInt16(18, true) * 0.006
        a.pointSourceId![w] = view.getUint16(20, true)
        if (a.gpsTime)
          a.gpsTime[w] = view.getFloat64(22, true)
        if (a.colors && pointFormat >= 7) {
          a.colors[w * 3] = view.getUint16(30, true) >> 8
          a.colors[w * 3 + 1] = view.getUint16(32, true) >> 8
          a.colors[w * 3 + 2] = view.getUint16(34, true) >> 8
        }
        if (a.nir && pointFormat >= 8) {
          a.nir[w] = view.getUint16(36, true)
        }
      }

      leaf.written++

      // Flush completed leaf tiles
      if (leaf.written === leaf.expectedCount) {
        const indices = new Uint32Array(leaf.written)
        for (let j = 0; j < leaf.written; j++) indices[j] = j
        const buf = encodeTileBinary(indices, 0, leaf.written, 1, leaf.attrs!)
        await writeTile(leaf.nodeId, buf)

        hierarchy.push({
          id: leaf.nodeId,
          level: leaf.depth,
          bounds: leaf.bounds,
          pointCount: leaf.written,
          childMask: 0,
          byteOffset: 0,
          byteSize: buf.byteLength,
        })

        // Free the buffers
        leaf.attrs = null
        nodesWritten++
      }

      if (i % 500_000 === 0) {
        onProgress?.({
          phase: 'writing',
          nodeId: leafId,
          depth: 0,
          pointsScanned: i,
          totalPoints: pointCount,
          nodesCompleted: nodesWritten,
          totalNodes: leafMap.size,
        })
      }
    }
  }
  finally {
    decoder.delete()
    lp._free(pointPtr)
    lp._free(srcPtr)
  }

  // Flush any remaining leaves that weren't fully filled
  // (can happen if point counts were slightly off due to bounds edge cases)
  for (const leaf of leafMap.values()) {
    if (leaf.attrs && leaf.written > 0) {
      const indices = new Uint32Array(leaf.written)
      for (let j = 0; j < leaf.written; j++) indices[j] = j

      // Trim buffers to actual written count
      const trimmed: TileAttributes = {
        positions: leaf.attrs.positions.slice(0, leaf.written * 3),
        colors: leaf.attrs.colors?.slice(0, leaf.written * 3),
        intensity: leaf.attrs.intensity.slice(0, leaf.written),
        classification: leaf.attrs.classification.slice(0, leaf.written),
        returnNumber: leaf.attrs.returnNumber?.slice(0, leaf.written),
        numberOfReturns: leaf.attrs.numberOfReturns?.slice(0, leaf.written),
        scanAngle: leaf.attrs.scanAngle?.slice(0, leaf.written),
        userData: leaf.attrs.userData?.slice(0, leaf.written),
        pointSourceId: leaf.attrs.pointSourceId?.slice(0, leaf.written),
        gpsTime: leaf.attrs.gpsTime?.slice(0, leaf.written),
        nir: leaf.attrs.nir?.slice(0, leaf.written),
        classificationFlags: leaf.attrs.classificationFlags?.slice(0, leaf.written),
        scannerChannel: leaf.attrs.scannerChannel?.slice(0, leaf.written),
      }

      const buf = encodeTileBinary(indices, 0, leaf.written, 1, trimmed)
      await writeTile(leaf.nodeId, buf)

      hierarchy.push({
        id: leaf.nodeId,
        level: leaf.depth,
        bounds: leaf.bounds,
        pointCount: leaf.written,
        childMask: 0,
        byteOffset: 0,
        byteSize: buf.byteLength,
      })

      leaf.attrs = null
    }
  }

  return hierarchy
}

// ---------------------------------------------------------------------------
// Helper: find which leaf a point belongs to
// ---------------------------------------------------------------------------

function findLeafId(
  x: number,
  y: number,
  z: number,
  bounds: Bounds,
  maxDepth: number,
  leafMap: Map<string, LeafDescriptor>,
): string | null {
  let nodeBounds = bounds
  let nodeId = '0-0-0-0'
  let parentX = 0
  let parentY = 0
  let parentZ = 0

  for (let d = 0; d <= maxDepth; d++) {
    if (leafMap.has(nodeId))
      return nodeId

    if (d === maxDepth)
      break

    const midX = (nodeBounds.min[0] + nodeBounds.max[0]) * 0.5
    const midY = (nodeBounds.min[1] + nodeBounds.max[1]) * 0.5
    const midZ = (nodeBounds.min[2] + nodeBounds.max[2]) * 0.5
    const octant = classifyOctant(x, y, z, midX, midY, midZ)

    const childDepth = d + 1
    const childX = parentX * 2 + (octant & 1)
    const childY = parentY * 2 + ((octant >> 1) & 1)
    const childZ = parentZ * 2 + ((octant >> 2) & 1)

    nodeId = `${childDepth}-${childX}-${childY}-${childZ}`
    nodeBounds = childBounds(nodeBounds, octant)
    parentX = childX
    parentY = childY
    parentZ = childZ
  }

  return leafMap.has(nodeId) ? nodeId : null
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type { LeafDescriptor, OctantCountNode }
