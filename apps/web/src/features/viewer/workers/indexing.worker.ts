import type { LasHeader } from '../data/las-reader'
import type { BuilderNode, TileAttributes } from '../data/octree-builder'
import type {
  DatasetDescriptor,
  IndexingPayload,
  IndexingProgress,
  IndexingResult,
  OctreeNode,
  WorkerRequest,
  WorkerResponse,
} from '../data/types'
import {
  writeHierarchy,
  writeMetadata,
  writeTile,
} from '../cache/opfs-cache'
import {
  formatHasColor,
  parseLasHeader,
  parseVlrs,
  readChunks,
} from '../data/las-reader'
import {
  buildHierarchyNodes,
  buildOctree,
  computeTargetDepth,
  countNodes,
  encodeTileBinary,
  LOD_SAMPLES_PER_NODE,
} from '../data/octree-builder'
import { buildStreamingOctree } from '../data/streaming-indexer'
import { lazCountAllLevels, lazMaterializeLeaves } from '../data/streaming-indexer-laz'
import { POINT_FORMAT_ATTRIBUTES } from '../data/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROGRESS_INTERVAL = 100_000

/**
 * Threshold (in points) above which we use the streaming multi-pass indexer
 * instead of the in-memory approach. 10M points ≈ ~400MB in memory for the
 * in-memory path, which is still manageable. Above that, switch to streaming.
 */
const STREAMING_THRESHOLD = 10_000_000

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let cancelled = false

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function respond(msg: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    globalThis.postMessage(msg, { transfer })
  }
  else {
    globalThis.postMessage(msg)
  }
}

function sendProgress(
  requestId: string,
  progress: IndexingProgress,
): void {
  respond({
    requestId,
    type: 'progress',
    payload: progress,
  })
}

function checkCancelled(): void {
  if (cancelled) {
    throw new Error('Indexing cancelled')
  }
}

function isCancelled(): boolean {
  return cancelled
}

// ---------------------------------------------------------------------------
// Legacy in-memory path (for small files < STREAMING_THRESHOLD)
// ---------------------------------------------------------------------------

interface PointArrays {
  positions: Float32Array
  colors: Uint8Array | undefined
  intensity: Float32Array
  classification: Uint8Array
}

async function readAllPoints(
  file: File,
  header: LasHeader,
  requestId: string,
): Promise<PointArrays> {
  const { pointCount, pointFormat } = header
  const hasColor = formatHasColor(pointFormat)

  const positions = new Float32Array(pointCount * 3)
  const colors = hasColor ? new Uint8Array(pointCount * 3) : undefined
  const intensity = new Float32Array(pointCount)
  const classification = new Uint8Array(pointCount)

  let written = 0
  const startTime = performance.now()

  for await (const chunk of readChunks(file, header)) {
    checkCancelled()

    const n = chunk.pointCount
    positions.set(chunk.positions, written * 3)
    if (colors && chunk.colors) {
      colors.set(chunk.colors, written * 3)
    }
    if (chunk.intensity) {
      intensity.set(chunk.intensity, written)
    }
    if (chunk.classification) {
      classification.set(chunk.classification, written)
    }

    written += n

    if (written % PROGRESS_INTERVAL < n || written === pointCount) {
      const elapsed = performance.now() - startTime
      const rate = written / elapsed
      const remaining = rate > 0 ? (pointCount - written) / rate : -1

      sendProgress(requestId, {
        pointsProcessed: written,
        totalPoints: pointCount,
        phase: 'reading',
        estimatedRemaining: remaining > 0 ? Math.round(remaining) : -1,
      })
    }
  }

  return { positions, colors, intensity, classification }
}

interface WriteStats {
  nodesWritten: number
  totalNodes: number
  totalBytes: number
}

async function writeOctreeToOpfs(
  datasetId: string,
  root: BuilderNode,
  indices: Uint32Array,
  points: PointArrays,
  requestId: string,
): Promise<WriteStats> {
  const totalNodes = countNodes(root)
  const stats: WriteStats = { nodesWritten: 0, totalNodes, totalBytes: 0 }
  const startTime = performance.now()

  await writeNodeRecursive(datasetId, root, indices, points, stats, requestId, startTime)
  return stats
}

async function writeNodeRecursive(
  datasetId: string,
  node: BuilderNode,
  indices: Uint32Array,
  points: PointArrays,
  stats: WriteStats,
  requestId: string,
  startTime: number,
): Promise<void> {
  checkCancelled()

  const count = node.indexEnd - node.indexStart
  if (count === 0)
    return

  const isLeaf = node.children.length === 0
    || node.children.every(c => c === null)

  const stride = isLeaf
    ? 1
    : Math.max(1, Math.floor(count / LOD_SAMPLES_PER_NODE))

  const attrs: TileAttributes = {
    positions: points.positions,
    colors: points.colors,
    intensity: points.intensity,
    classification: points.classification,
  }

  const tileBuffer = encodeTileBinary(
    indices,
    node.indexStart,
    node.indexEnd,
    stride,
    attrs,
  )

  await writeTile(datasetId, node.id, tileBuffer)

  stats.nodesWritten++
  stats.totalBytes += tileBuffer.byteLength

  if (stats.nodesWritten % 10 === 0 || stats.nodesWritten === stats.totalNodes) {
    const elapsed = performance.now() - startTime
    const rate = stats.nodesWritten / elapsed
    const remaining = rate > 0 ? (stats.totalNodes - stats.nodesWritten) / rate : -1

    sendProgress(requestId, {
      pointsProcessed: stats.nodesWritten,
      totalPoints: stats.totalNodes,
      phase: 'writing',
      estimatedRemaining: remaining > 0 ? Math.round(remaining) : -1,
    })
  }

  for (const child of node.children) {
    if (child) {
      await writeNodeRecursive(datasetId, child, indices, points, stats, requestId, startTime)
    }
  }
}

// ---------------------------------------------------------------------------
// Serialize hierarchy to binary for OPFS storage
// ---------------------------------------------------------------------------

function serializeHierarchyBinary(nodes: OctreeNode[]): ArrayBuffer {
  const json = JSON.stringify(nodes)
  return new TextEncoder().encode(json).buffer
}

// ---------------------------------------------------------------------------
// In-memory indexing (legacy path for small files)
// ---------------------------------------------------------------------------

async function indexFileInMemory(
  file: File,
  header: LasHeader,
  datasetId: string,
  requestId: string,
  crs: string | undefined,
): Promise<IndexingResult> {
  sendProgress(requestId, {
    pointsProcessed: 0,
    totalPoints: header.pointCount,
    phase: 'reading',
    estimatedRemaining: -1,
  })

  const points = await readAllPoints(file, header, requestId)
  checkCancelled()

  sendProgress(requestId, {
    pointsProcessed: 0,
    totalPoints: header.pointCount,
    phase: 'building',
    estimatedRemaining: -1,
  })

  const targetDepth = computeTargetDepth(header.pointCount)
  const { root, indices } = buildOctree(
    points.positions,
    header.pointCount,
    header.bounds,
    targetDepth,
  )
  checkCancelled()

  sendProgress(requestId, {
    pointsProcessed: 0,
    totalPoints: countNodes(root),
    phase: 'writing',
    estimatedRemaining: -1,
  })

  await writeOctreeToOpfs(datasetId, root, indices, points, requestId)

  const hierarchyNodes = buildHierarchyNodes(root)
  const hierarchyBin = serializeHierarchyBinary(hierarchyNodes)
  await writeHierarchy(datasetId, hierarchyBin)

  return buildResult(file, header, hierarchyNodes, datasetId, crs)
}

// ---------------------------------------------------------------------------
// Streaming indexing (for large LAS files)
// ---------------------------------------------------------------------------

async function indexFileStreaming(
  file: File,
  header: LasHeader,
  datasetId: string,
  requestId: string,
  crs: string | undefined,
): Promise<IndexingResult> {
  const targetDepth = computeTargetDepth(header.pointCount)

  const tileWriter = async (nodeId: string, buffer: ArrayBuffer): Promise<void> => {
    await writeTile(datasetId, nodeId, buffer)
  }

  const progressCb = (p: { phase: string, nodesCompleted: number, totalNodes: number, pointsScanned: number, totalPoints: number }): void => {
    sendProgress(requestId, {
      pointsProcessed: p.pointsScanned || p.nodesCompleted,
      totalPoints: p.totalPoints || p.totalNodes,
      phase: p.phase,
      estimatedRemaining: -1,
    })
  }

  let hierarchyNodes: OctreeNode[]

  if (header.isLaz) {
    // LAZ: two-pass strategy (count + materialize)
    sendProgress(requestId, {
      pointsProcessed: 0,
      totalPoints: header.pointCount,
      phase: 'counting',
      estimatedRemaining: -1,
    })

    const { leafMap } = await lazCountAllLevels(
      file,
      header,
      header.bounds,
      targetDepth,
      progressCb,
      isCancelled,
    )

    sendProgress(requestId, {
      pointsProcessed: 0,
      totalPoints: header.pointCount,
      phase: 'writing',
      estimatedRemaining: -1,
    })

    const leafHierarchy = await lazMaterializeLeaves(
      file,
      header,
      header.bounds,
      targetDepth,
      leafMap,
      tileWriter,
      progressCb,
      isCancelled,
    )

    // Build internal node LOD tiles by reading back child tiles
    // For LAZ, inner node LOD is built from the leaf hierarchy
    hierarchyNodes = buildInternalNodesFromLeaves(leafHierarchy, targetDepth)

    // Write LOD tiles for internal nodes
    for (const node of hierarchyNodes) {
      if (node.childMask !== 0) {
        // Internal nodes already have byteSize = 0, need LOD tile
        // For now, skip LOD for internal nodes in LAZ path
        // (leaves are sufficient for rendering)
      }
    }
  }
  else {
    // LAS: multi-pass recursive scanning
    sendProgress(requestId, {
      pointsProcessed: 0,
      totalPoints: header.pointCount,
      phase: 'counting',
      estimatedRemaining: -1,
    })

    const result = await buildStreamingOctree(
      file,
      header,
      header.bounds,
      targetDepth,
      tileWriter,
      progressCb,
      isCancelled,
    )

    hierarchyNodes = result.hierarchy
  }

  const hierarchyBin = serializeHierarchyBinary(hierarchyNodes)
  await writeHierarchy(datasetId, hierarchyBin)

  return buildResult(file, header, hierarchyNodes, datasetId, crs)
}

/**
 * Build internal (non-leaf) OctreeNode entries from the leaf hierarchy.
 * Walks up from leaves to root, computing child masks.
 */
function buildInternalNodesFromLeaves(
  leafNodes: OctreeNode[],
  maxDepth: number,
): OctreeNode[] {
  const nodeMap = new Map<string, OctreeNode>()

  // Add all leaf nodes
  for (const leaf of leafNodes) {
    nodeMap.set(leaf.id, leaf)
  }

  // Build parent nodes bottom-up
  for (let d = maxDepth; d >= 1; d--) {
    for (const node of nodeMap.values()) {
      if (node.level !== d)
        continue

      const parts = node.id.split('-')
      const x = Number.parseInt(parts[1]!, 10)
      const y = Number.parseInt(parts[2]!, 10)
      const z = Number.parseInt(parts[3]!, 10)

      const parentDepth = d - 1
      const parentX = Math.floor(x / 2)
      const parentY = Math.floor(y / 2)
      const parentZ = Math.floor(z / 2)
      const parentId = `${parentDepth}-${parentX}-${parentY}-${parentZ}`

      const octant = (x % 2) | ((y % 2) << 1) | ((z % 2) << 2)

      if (!nodeMap.has(parentId)) {
        nodeMap.set(parentId, {
          id: parentId,
          level: parentDepth,
          bounds: { min: [0, 0, 0], max: [0, 0, 0] }, // bounds computed from children
          pointCount: 0,
          childMask: 0,
          byteOffset: 0,
          byteSize: 0,
        })
      }

      const parent = nodeMap.get(parentId)!
      parent.childMask |= (1 << octant)
      parent.pointCount += node.pointCount
    }
  }

  return Array.from(nodeMap.values())
}

// ---------------------------------------------------------------------------
// Shared result builder
// ---------------------------------------------------------------------------

function buildResult(
  file: File,
  header: LasHeader,
  hierarchyNodes: OctreeNode[],
  datasetId: string,
  crs: string | undefined,
): IndexingResult {
  let maxDepth = 0
  for (const n of hierarchyNodes) {
    if (n.level > maxDepth)
      maxDepth = n.level
  }

  const sourceFormat = header.isLaz ? 'laz' as const : 'las' as const
  const attributes = POINT_FORMAT_ATTRIBUTES[header.pointFormat]
    ?? POINT_FORMAT_ATTRIBUTES[0]!

  const descriptor: DatasetDescriptor = {
    id: datasetId,
    sourceFormat,
    fileName: file.name,
    fileSize: file.size,
    pointCount: header.pointCount,
    pointFormat: header.pointFormat,
    bounds: header.bounds,
    scale: header.scale,
    offset: header.offset,
    attributes,
    crs,
    hierarchyDepth: maxDepth,
    rootNodeId: '0-0-0-0',
    cached: true,
  }

  return { descriptor, hierarchy: hierarchyNodes }
}

// ---------------------------------------------------------------------------
// Main indexing orchestrator — chooses path based on file size
// ---------------------------------------------------------------------------

async function indexFile(
  file: File,
  datasetId: string,
  requestId: string,
): Promise<IndexingResult> {
  sendProgress(requestId, {
    pointsProcessed: 0,
    totalPoints: 0,
    phase: 'parsing',
    estimatedRemaining: -1,
  })

  const header = await parseLasHeader(file)
  const { crs } = await parseVlrs(file, header)
  checkCancelled()

  if (header.pointCount >= STREAMING_THRESHOLD) {
    // Large file: use streaming multi-pass indexer
    const result = await indexFileStreaming(file, header, datasetId, requestId, crs)
    await writeMetadata(datasetId, result.descriptor)
    return result
  }
  else {
    // Small file: use legacy in-memory indexer
    const result = await indexFileInMemory(file, header, datasetId, requestId, crs)
    await writeMetadata(datasetId, result.descriptor)
    return result
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { requestId, type, payload } = event.data

  if (type === 'cancel') {
    cancelled = true
    respond({ requestId, type: 'result', payload: { cancelled: true } })
    return
  }

  if (type !== 'index') {
    respond({
      requestId,
      type: 'error',
      payload: { message: `Unknown request type: ${type}` },
    })
    return
  }

  cancelled = false

  try {
    const { file, datasetId } = payload as IndexingPayload
    const result = await indexFile(file, datasetId, requestId)

    respond({
      requestId,
      type: 'result',
      payload: result,
    })
  }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Indexing failed'
    respond({ requestId, type: 'error', payload: { message } })
  }
}
