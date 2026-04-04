/**
 * Streaming multi-pass octree indexer for large LAS/LAZ files.
 *
 * Instead of loading all points into memory, this module scans the file
 * multiple times with narrowing spatial bounds at each octree level.
 * Memory usage is bounded by the size of a single leaf node, not total
 * file size.
 *
 * Architecture:
 *   Pass 0: scan entire file → count points per top-level octant
 *   Pass 1..N: for each octant with > MIN_LEAF_POINTS, scan again
 *   Leaf pass: read full point attributes → encode tile → write OPFS
 */

import type { LasHeader } from './las-reader'
import type { Bounds, OctreeNode } from './types'
import type { TileAttributes } from './octree-builder'
import {
  encodeTileBinary,
  FLAG_HAS_COLOR,
  FLAG_HAS_EXTRA,
  FLAG_HAS_GPS_TIME,
  FLAG_HAS_NIR,
  FLAG_HAS_RETURN_NUMBER,
  FLAG_HAS_SCAN_ANGLE,
  LOD_SAMPLES_PER_NODE,
  MIN_LEAF_POINTS,
} from './octree-builder'
import { formatHasColor, POINT_RECORD_BASE_SIZES } from './las-reader'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamingProgress {
  phase: 'counting' | 'writing' | 'lod'
  nodeId: string
  depth: number
  pointsScanned: number
  totalPoints: number
  nodesCompleted: number
  totalNodes: number
}

export type ProgressCallback = (progress: StreamingProgress) => void
export type TileWriteCallback = (nodeId: string, buffer: ArrayBuffer) => Promise<void>
export type CancelCheck = () => boolean

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Chunk size for reading uncompressed LAS points (in points, not bytes). */
const SCAN_CHUNK_SIZE = 200_000

// ---------------------------------------------------------------------------
// Core: classify a point's XYZ into an octant index (0-7)
// ---------------------------------------------------------------------------

function classifyOctant(
  x: number, y: number, z: number,
  midX: number, midY: number, midZ: number,
): number {
  return (x >= midX ? 1 : 0)
    | (y >= midY ? 2 : 0)
    | (z >= midZ ? 4 : 0)
}

// ---------------------------------------------------------------------------
// Compute child bounds for a given octant
// ---------------------------------------------------------------------------

function childBounds(parent: Bounds, octant: number): Bounds {
  const { min, max } = parent
  const midX = (min[0] + max[0]) * 0.5
  const midY = (min[1] + max[1]) * 0.5
  const midZ = (min[2] + max[2]) * 0.5

  return {
    min: [
      (octant & 1) ? midX : min[0],
      (octant & 2) ? midY : min[1],
      (octant & 4) ? midZ : min[2],
    ],
    max: [
      (octant & 1) ? max[0] : midX,
      (octant & 2) ? max[1] : midY,
      (octant & 4) ? max[2] : midZ,
    ],
  }
}

// ---------------------------------------------------------------------------
// Point-in-bounds test
// ---------------------------------------------------------------------------

function pointInBounds(x: number, y: number, z: number, b: Bounds): boolean {
  return x >= b.min[0] && x < b.max[0]
    && y >= b.min[1] && y < b.max[1]
    && z >= b.min[2] && z < b.max[2]
}

// ---------------------------------------------------------------------------
// Phase 1: Count points per octant by scanning a spatial region of the file
// ---------------------------------------------------------------------------

/**
 * Scans the LAS file and counts how many points fall into each of the 8
 * child octants of the given bounds. Only decodes XYZ — no attributes.
 *
 * For uncompressed LAS, uses File.slice() for zero-copy region reads.
 * Returns an array of 8 counts.
 */
export async function countOctants(
  file: File,
  header: LasHeader,
  regionBounds: Bounds,
  cancel?: CancelCheck,
): Promise<Uint32Array> {
  const counts = new Uint32Array(8)
  const { pointCount, pointRecordLength, offsetToPointData, scale, offset: fileOffset } = header

  const midX = (regionBounds.min[0] + regionBounds.max[0]) * 0.5
  const midY = (regionBounds.min[1] + regionBounds.max[1]) * 0.5
  const midZ = (regionBounds.min[2] + regionBounds.max[2]) * 0.5

  let remaining = pointCount
  let filePos = offsetToPointData

  while (remaining > 0) {
    if (cancel?.()) throw new Error('Cancelled')

    const batchCount = Math.min(SCAN_CHUNK_SIZE, remaining)
    const batchBytes = batchCount * pointRecordLength
    const buf = await file.slice(filePos, filePos + batchBytes).arrayBuffer()
    const view = new DataView(buf)

    for (let i = 0; i < batchCount; i++) {
      const off = i * pointRecordLength
      const xi = view.getInt32(off, true)
      const yi = view.getInt32(off + 4, true)
      const zi = view.getInt32(off + 8, true)

      const x = xi * scale[0] + fileOffset[0]
      const y = yi * scale[1] + fileOffset[1]
      const z = zi * scale[2] + fileOffset[2]

      if (!pointInBounds(x, y, z, regionBounds)) continue

      const octant = classifyOctant(x, y, z, midX, midY, midZ)
      counts[octant]++
    }

    filePos += batchBytes
    remaining -= batchCount
  }

  return counts
}

// ---------------------------------------------------------------------------
// Phase 2: Read all points within a spatial region (for leaf materialization)
// ---------------------------------------------------------------------------

/**
 * Reads all points within `regionBounds` from the LAS file, decoding
 * all attributes. Returns typed arrays suitable for tile encoding.
 *
 * Memory: O(pointsInRegion) — bounded by leaf node size.
 */
export async function readRegionPoints(
  file: File,
  header: LasHeader,
  regionBounds: Bounds,
  expectedCount: number,
  cancel?: CancelCheck,
): Promise<TileAttributes & { pointCount: number }> {
  const { pointCount: totalPoints, pointRecordLength, offsetToPointData, pointFormat, scale, offset: fileOffset } = header
  const hasColor = formatHasColor(pointFormat)
  const hasGpsTime = pointFormat === 1 || pointFormat === 3 || pointFormat >= 6
  const hasNir = pointFormat === 8
  const is14 = pointFormat >= 6

  const positions = new Float32Array(expectedCount * 3)
  const colors = hasColor ? new Uint8Array(expectedCount * 3) : undefined
  const intensity = new Float32Array(expectedCount)
  const classification = new Uint8Array(expectedCount)
  const returnNumber = new Uint8Array(expectedCount)
  const numberOfReturns = new Uint8Array(expectedCount)
  const scanAngle = new Float32Array(expectedCount)
  const userData = new Uint8Array(expectedCount)
  const pointSourceId = new Uint16Array(expectedCount)
  const gpsTime = hasGpsTime ? new Float64Array(expectedCount) : undefined
  const nir = hasNir ? new Uint16Array(expectedCount) : undefined
  const classificationFlags = is14 ? new Uint8Array(expectedCount) : undefined
  const scannerChannel = is14 ? new Uint8Array(expectedCount) : undefined

  let written = 0
  let remaining = totalPoints
  let filePos = offsetToPointData

  while (remaining > 0) {
    if (cancel?.()) throw new Error('Cancelled')

    const batchCount = Math.min(SCAN_CHUNK_SIZE, remaining)
    const batchBytes = batchCount * pointRecordLength
    const buf = await file.slice(filePos, filePos + batchBytes).arrayBuffer()
    const view = new DataView(buf)

    for (let i = 0; i < batchCount; i++) {
      const off = i * pointRecordLength
      const xi = view.getInt32(off, true)
      const yi = view.getInt32(off + 4, true)
      const zi = view.getInt32(off + 8, true)

      const x = xi * scale[0] + fileOffset[0]
      const y = yi * scale[1] + fileOffset[1]
      const z = zi * scale[2] + fileOffset[2]

      if (!pointInBounds(x, y, z, regionBounds)) continue

      const w = written
      positions[w * 3] = x
      positions[w * 3 + 1] = y
      positions[w * 3 + 2] = z

      intensity[w] = view.getUint16(off + 12, true) / 65535

      if (pointFormat <= 5) {
        const flagByte = view.getUint8(off + 14)
        returnNumber[w] = flagByte & 0x07
        numberOfReturns[w] = (flagByte >> 3) & 0x07
        classification[w] = view.getUint8(off + 15)
        scanAngle[w] = view.getInt8(off + 16)
        userData[w] = view.getUint8(off + 17)
        pointSourceId[w] = view.getUint16(off + 18, true)

        if (pointFormat === 1 || pointFormat === 3) {
          if (gpsTime) gpsTime[w] = view.getFloat64(off + 20, true)
        }
        if (pointFormat === 2 && colors) {
          colors[w * 3] = view.getUint16(off + 20, true) >> 8
          colors[w * 3 + 1] = view.getUint16(off + 22, true) >> 8
          colors[w * 3 + 2] = view.getUint16(off + 24, true) >> 8
        }
        if (pointFormat === 3 && colors) {
          colors[w * 3] = view.getUint16(off + 28, true) >> 8
          colors[w * 3 + 1] = view.getUint16(off + 30, true) >> 8
          colors[w * 3 + 2] = view.getUint16(off + 32, true) >> 8
        }
      }
      else {
        // LAS 1.4 formats 6-8
        const flagByte = view.getUint8(off + 14)
        returnNumber[w] = flagByte & 0x0F
        numberOfReturns[w] = (flagByte >> 4) & 0x0F
        const flagByte2 = view.getUint8(off + 15)
        if (classificationFlags) classificationFlags[w] = flagByte2 & 0x0F
        if (scannerChannel) scannerChannel[w] = (flagByte2 >> 4) & 0x03
        classification[w] = view.getUint8(off + 16)
        userData[w] = view.getUint8(off + 17)
        scanAngle[w] = view.getInt16(off + 18, true) * 0.006
        pointSourceId[w] = view.getUint16(off + 20, true)
        if (gpsTime) gpsTime[w] = view.getFloat64(off + 22, true)

        if (pointFormat >= 7 && colors) {
          colors[w * 3] = view.getUint16(off + 30, true) >> 8
          colors[w * 3 + 1] = view.getUint16(off + 32, true) >> 8
          colors[w * 3 + 2] = view.getUint16(off + 34, true) >> 8
        }
        if (pointFormat >= 8 && nir) {
          nir[w] = view.getUint16(off + 36, true)
        }
      }

      written++
    }

    filePos += batchBytes
    remaining -= batchCount
  }

  return {
    pointCount: written,
    positions: written === expectedCount ? positions : positions.slice(0, written * 3),
    colors: colors ? (written === expectedCount ? colors : colors.slice(0, written * 3)) : undefined,
    intensity: written === expectedCount ? intensity : intensity.slice(0, written),
    classification: written === expectedCount ? classification : classification.slice(0, written),
    returnNumber: written === expectedCount ? returnNumber : returnNumber.slice(0, written),
    numberOfReturns: written === expectedCount ? numberOfReturns : numberOfReturns.slice(0, written),
    scanAngle: written === expectedCount ? scanAngle : scanAngle.slice(0, written),
    userData: written === expectedCount ? userData : userData.slice(0, written),
    pointSourceId: written === expectedCount ? pointSourceId : pointSourceId.slice(0, written),
    gpsTime: gpsTime ? (written === expectedCount ? gpsTime : gpsTime.slice(0, written)) : undefined,
    nir: nir ? (written === expectedCount ? nir : nir.slice(0, written)) : undefined,
    classificationFlags: classificationFlags ? (written === expectedCount ? classificationFlags : classificationFlags.slice(0, written)) : undefined,
    scannerChannel: scannerChannel ? (written === expectedCount ? scannerChannel : scannerChannel.slice(0, written)) : undefined,
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Recursive subdivision driver
// ---------------------------------------------------------------------------

export interface StreamingIndexResult {
  hierarchy: OctreeNode[]
  totalNodes: number
  totalBytes: number
}

/**
 * Build octree by recursively scanning the file. At each level, count
 * points per octant; recurse into children or materialize leaf tiles.
 */
export async function buildStreamingOctree(
  file: File,
  header: LasHeader,
  bounds: Bounds,
  targetDepth: number,
  writeTile: TileWriteCallback,
  onProgress?: ProgressCallback,
  cancel?: CancelCheck,
): Promise<StreamingIndexResult> {
  const hierarchy: OctreeNode[] = []
  let totalNodes = 0
  let totalBytes = 0

  // First pass: count total points in root region (should equal header.pointCount
  // for the root, but we keep it consistent for sub-regions)
  const rootCounts = await countOctants(file, header, bounds, cancel)
  const rootTotal = rootCounts.reduce((a, b) => a + b, 0)

  onProgress?.({
    phase: 'counting',
    nodeId: '0-0-0-0',
    depth: 0,
    pointsScanned: rootTotal,
    totalPoints: header.pointCount,
    nodesCompleted: 0,
    totalNodes: 0,
  })

  await buildNodeRecursive(
    file, header, bounds, '0-0-0-0', 0, targetDepth,
    rootTotal, rootCounts,
    hierarchy, writeTile, onProgress, cancel,
    { totalNodes: 0, totalBytes: 0, nodesCompleted: 0 },
  )

  totalNodes = hierarchy.length
  totalBytes = hierarchy.reduce((sum, n) => sum + n.byteSize, 0)

  return { hierarchy, totalNodes, totalBytes }
}

interface BuildStats {
  totalNodes: number
  totalBytes: number
  nodesCompleted: number
}

async function buildNodeRecursive(
  file: File,
  header: LasHeader,
  nodeBounds: Bounds,
  nodeId: string,
  depth: number,
  maxDepth: number,
  pointCount: number,
  childCounts: Uint32Array | null,
  hierarchy: OctreeNode[],
  writeTile: TileWriteCallback,
  onProgress: ProgressCallback | undefined,
  cancel: CancelCheck | undefined,
  stats: BuildStats,
): Promise<void> {
  if (cancel?.()) throw new Error('Cancelled')

  const isLeaf = depth >= maxDepth || pointCount <= MIN_LEAF_POINTS

  if (isLeaf) {
    // Leaf: materialize tile with full attribute data
    const regionData = await readRegionPoints(file, header, nodeBounds, pointCount, cancel)

    // Build sequential indices for encoding
    const indices = new Uint32Array(regionData.pointCount)
    for (let i = 0; i < regionData.pointCount; i++) indices[i] = i

    const tileBuffer = encodeTileBinary(indices, 0, regionData.pointCount, 1, regionData)
    await writeTile(nodeId, tileBuffer)

    hierarchy.push({
      id: nodeId,
      level: depth,
      bounds: nodeBounds,
      pointCount: regionData.pointCount,
      childMask: 0,
      byteOffset: 0,
      byteSize: tileBuffer.byteLength,
    })

    stats.nodesCompleted++
    stats.totalBytes += tileBuffer.byteLength

    onProgress?.({
      phase: 'writing',
      nodeId,
      depth,
      pointsScanned: 0,
      totalPoints: header.pointCount,
      nodesCompleted: stats.nodesCompleted,
      totalNodes: stats.totalNodes,
    })

    return
  }

  // Internal node: get child counts if not already provided
  const counts = childCounts ?? await countOctants(file, header, nodeBounds, cancel)

  // Determine child mask
  let childMask = 0
  for (let o = 0; o < 8; o++) {
    if (counts[o]! > 0) childMask |= (1 << o)
  }

  // Parse parent key for child ID generation
  const parts = nodeId.split('-')
  const parentX = Number.parseInt(parts[1]!, 10)
  const parentY = Number.parseInt(parts[2]!, 10)
  const parentZ = Number.parseInt(parts[3]!, 10)

  // Recurse into non-empty children
  for (let o = 0; o < 8; o++) {
    const childCount = counts[o]!
    if (childCount === 0) continue

    const childDepth = depth + 1
    const childX = parentX * 2 + (o & 1)
    const childY = parentY * 2 + ((o >> 1) & 1)
    const childZ = parentZ * 2 + ((o >> 2) & 1)
    const childId = `${childDepth}-${childX}-${childY}-${childZ}`
    const cBounds = childBounds(nodeBounds, o)

    await buildNodeRecursive(
      file, header, cBounds, childId, childDepth, maxDepth,
      childCount, null,
      hierarchy, writeTile, onProgress, cancel, stats,
    )
  }

  // After children are written, create LOD sample for this internal node
  // by reading a subsample from the region
  const stride = Math.max(1, Math.floor(pointCount / LOD_SAMPLES_PER_NODE))
  const lodCount = Math.ceil(pointCount / stride)

  const lodData = await readRegionLod(file, header, nodeBounds, stride, lodCount, cancel)

  const lodIndices = new Uint32Array(lodData.pointCount)
  for (let i = 0; i < lodData.pointCount; i++) lodIndices[i] = i

  const lodBuffer = encodeTileBinary(lodIndices, 0, lodData.pointCount, 1, lodData)
  await writeTile(nodeId, lodBuffer)

  hierarchy.push({
    id: nodeId,
    level: depth,
    bounds: nodeBounds,
    pointCount: lodData.pointCount,
    childMask,
    byteOffset: 0,
    byteSize: lodBuffer.byteLength,
  })

  stats.nodesCompleted++
  stats.totalBytes += lodBuffer.byteLength

  onProgress?.({
    phase: 'lod',
    nodeId,
    depth,
    pointsScanned: 0,
    totalPoints: header.pointCount,
    nodesCompleted: stats.nodesCompleted,
    totalNodes: stats.totalNodes,
  })
}

// ---------------------------------------------------------------------------
// LOD sampling: read every Nth point in a region (for internal nodes)
// ---------------------------------------------------------------------------

async function readRegionLod(
  file: File,
  header: LasHeader,
  regionBounds: Bounds,
  stride: number,
  expectedCount: number,
  cancel?: CancelCheck,
): Promise<TileAttributes & { pointCount: number }> {
  const { pointCount: totalPoints, pointRecordLength, offsetToPointData, pointFormat, scale, offset: fileOffset } = header
  const hasColor = formatHasColor(pointFormat)

  const positions = new Float32Array(expectedCount * 3)
  const intensity = new Float32Array(expectedCount)
  const classification = new Uint8Array(expectedCount)
  const colors = hasColor ? new Uint8Array(expectedCount * 3) : undefined

  let written = 0
  let hitIndex = 0 // counts points that match the region
  let remaining = totalPoints
  let filePos = offsetToPointData

  while (remaining > 0) {
    if (cancel?.()) throw new Error('Cancelled')

    const batchCount = Math.min(SCAN_CHUNK_SIZE, remaining)
    const batchBytes = batchCount * pointRecordLength
    const buf = await file.slice(filePos, filePos + batchBytes).arrayBuffer()
    const view = new DataView(buf)

    for (let i = 0; i < batchCount; i++) {
      const off = i * pointRecordLength
      const xi = view.getInt32(off, true)
      const yi = view.getInt32(off + 4, true)
      const zi = view.getInt32(off + 8, true)

      const x = xi * scale[0] + fileOffset[0]
      const y = yi * scale[1] + fileOffset[1]
      const z = zi * scale[2] + fileOffset[2]

      if (!pointInBounds(x, y, z, regionBounds)) continue

      // Only keep every Nth matching point
      if (hitIndex % stride === 0 && written < expectedCount) {
        positions[written * 3] = x
        positions[written * 3 + 1] = y
        positions[written * 3 + 2] = z
        intensity[written] = view.getUint16(off + 12, true) / 65535

        if (pointFormat <= 5) {
          classification[written] = view.getUint8(off + 15)
          if (colors) {
            if (pointFormat === 2) {
              colors[written * 3] = view.getUint16(off + 20, true) >> 8
              colors[written * 3 + 1] = view.getUint16(off + 22, true) >> 8
              colors[written * 3 + 2] = view.getUint16(off + 24, true) >> 8
            }
            else if (pointFormat === 3) {
              colors[written * 3] = view.getUint16(off + 28, true) >> 8
              colors[written * 3 + 1] = view.getUint16(off + 30, true) >> 8
              colors[written * 3 + 2] = view.getUint16(off + 32, true) >> 8
            }
          }
        }
        else {
          classification[written] = view.getUint8(off + 16)
          if (colors && pointFormat >= 7) {
            colors[written * 3] = view.getUint16(off + 30, true) >> 8
            colors[written * 3 + 1] = view.getUint16(off + 32, true) >> 8
            colors[written * 3 + 2] = view.getUint16(off + 34, true) >> 8
          }
        }

        written++
      }

      hitIndex++
    }

    filePos += batchBytes
    remaining -= batchCount
  }

  return {
    pointCount: written,
    positions: written === expectedCount ? positions : positions.slice(0, written * 3),
    colors: colors ? (written === expectedCount ? colors : colors.slice(0, written * 3)) : undefined,
    intensity: written === expectedCount ? intensity : intensity.slice(0, written),
    classification: written === expectedCount ? classification : classification.slice(0, written),
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { childBounds, classifyOctant, pointInBounds }
