import type { LasHeader } from '../data/las-reader'
import type { BuilderNode } from '../data/octree-builder'
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
import { POINT_FORMAT_ATTRIBUTES } from '../data/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROGRESS_INTERVAL = 100_000

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

// ---------------------------------------------------------------------------
// Phase 1: Read all points into flat typed arrays
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

// ---------------------------------------------------------------------------
// Phase 2: Write octree nodes to OPFS (DFS traversal)
// ---------------------------------------------------------------------------

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

  const tileBuffer = encodeTileBinary(
    indices,
    node.indexStart,
    node.indexEnd,
    stride,
    points.positions,
    points.colors,
    points.intensity,
    points.classification,
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
// Main indexing orchestrator
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

  const sourceFormat = header.isLaz ? 'laz' as const : 'las' as const

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

  let maxDepth = 0
  for (const n of hierarchyNodes) {
    if (n.level > maxDepth)
      maxDepth = n.level
  }

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

  await writeMetadata(datasetId, descriptor)

  return { descriptor, hierarchy: hierarchyNodes }
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
