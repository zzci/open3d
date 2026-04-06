import type { Bounds, DecodeTilePayload, OctreeNode, TileData } from '../data/types'
import type { LodPolicyConfig } from './lod-policy'
import type { ViewState } from './view-state'
import { getChildIds } from '../data/hierarchy'
import { computeScreenSpaceError, DEFAULT_LOD_CONFIG, shouldSplit } from './lod-policy'
import { distanceToBoundsCenter, intersectsFrustum } from './view-state'

// ---------------------------------------------------------------------------
// Quality presets
// ---------------------------------------------------------------------------

export interface QualityPreset {
  pointBudget: number
  maxActiveTiles: number
}

export const QUALITY_PRESETS: Record<'low' | 'medium' | 'high', QualityPreset> = {
  low: { pointBudget: 2_000_000, maxActiveTiles: 50 },
  medium: { pointBudget: 4_000_000, maxActiveTiles: 150 },
  high: { pointBudget: 8_000_000, maxActiveTiles: 300 },
}

// ---------------------------------------------------------------------------
// Tile state managed by the scheduler
// ---------------------------------------------------------------------------

export type TileStatus = 'pending' | 'loading' | 'loaded' | 'evicted'

export interface ManagedTile {
  node: OctreeNode
  status: TileStatus
  data: TileData | null
  screenSpaceError: number
  distanceToCamera: number
}

// ---------------------------------------------------------------------------
// Scheduler configuration
// ---------------------------------------------------------------------------

export interface TileSchedulerConfig {
  pointBudget: number
  maxActiveTiles: number
  lodConfig: LodPolicyConfig
}

const DEFAULT_CONFIG: TileSchedulerConfig = {
  ...QUALITY_PRESETS.medium,
  lodConfig: DEFAULT_LOD_CONFIG,
}

// ---------------------------------------------------------------------------
// Decode request dispatcher — abstraction over the worker pool
// ---------------------------------------------------------------------------

export type DecodeDispatcher = (payload: DecodeTilePayload) => Promise<TileData>

// ---------------------------------------------------------------------------
// Callbacks for renderer integration
// ---------------------------------------------------------------------------

export interface SchedulerCallbacks {
  onTileLoaded: (nodeId: string, data: TileData) => void
  onTileEvicted: (nodeId: string) => void
}

// ---------------------------------------------------------------------------
// Priority entry for the traversal queue (max-heap by SSE)
// ---------------------------------------------------------------------------

interface TraversalEntry {
  node: OctreeNode
  sse: number
}

// ---------------------------------------------------------------------------
// TileScheduler — main scheduling loop
//
// Runs on main thread. Performs lightweight math (frustum cull, SSE)
// and dispatches decode requests to the Worker pool.
// ---------------------------------------------------------------------------

export class TileScheduler {
  private readonly hierarchy: Map<string, OctreeNode>
  private readonly tiles: Map<string, ManagedTile> = new Map()
  private readonly inFlight: Set<string> = new Set()
  private readonly decode: DecodeDispatcher
  private readonly callbacks: SchedulerCallbacks
  private readonly datasetMeta: DatasetMeta
  private readonly rootSpacing: number
  private config: TileSchedulerConfig
  private disposed = false

  constructor(
    hierarchy: Map<string, OctreeNode>,
    decode: DecodeDispatcher,
    callbacks: SchedulerCallbacks,
    datasetMeta: DatasetMeta,
    config?: Partial<TileSchedulerConfig>,
  ) {
    this.hierarchy = hierarchy
    this.decode = decode
    this.callbacks = callbacks
    this.datasetMeta = datasetMeta
    this.config = { ...DEFAULT_CONFIG, ...config }

    // Compute root spacing from root node bounds diagonal
    const root = hierarchy.get('0-0-0-0')
    this.rootSpacing = root ? boundsDiagonal(root.bounds) : 1.0
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Update the quality / budget at runtime */
  setConfig(partial: Partial<TileSchedulerConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /** Apply a quality preset */
  setQuality(preset: 'low' | 'medium' | 'high'): void {
    const q = QUALITY_PRESETS[preset]
    this.config = { ...this.config, pointBudget: q.pointBudget, maxActiveTiles: q.maxActiveTiles }
  }

  /** Run one scheduling pass given the current camera state */
  update(view: ViewState): void {
    if (this.disposed)
      return

    const wanted = this.traverse(view)
    this.evict(wanted, view)
    this.requestLoads(wanted)
  }

  /** Number of points currently loaded */
  get loadedPointCount(): number {
    let total = 0
    for (const tile of this.tiles.values()) {
      if (tile.status === 'loaded') {
        total += tile.node.pointCount
      }
    }
    return total
  }

  /** Number of active (loaded) tiles */
  get activeTileCount(): number {
    let count = 0
    for (const tile of this.tiles.values()) {
      if (tile.status === 'loaded')
        count++
    }
    return count
  }

  /** Clean up — cancel in-flight, evict all */
  dispose(): void {
    this.disposed = true
    for (const [id, tile] of this.tiles) {
      if (tile.status === 'loaded') {
        this.callbacks.onTileEvicted(id)
      }
    }
    this.tiles.clear()
    this.inFlight.clear()
  }

  // -----------------------------------------------------------------------
  // Traversal — BFS ordered by screen-space error (largest first)
  // -----------------------------------------------------------------------

  private traverse(view: ViewState): Map<string, TraversalEntry> {
    const { frustumPlanes, cameraPosition, screenHeight, fov } = view
    const { pointBudget, maxActiveTiles, lodConfig } = this.config

    const wanted = new Map<string, TraversalEntry>()
    let pointsAccum = 0

    // Priority queue: simple sorted array (hierarchy is typically small enough)
    const queue: TraversalEntry[] = []

    // Seed with root node
    const root = this.hierarchy.get('0-0-0-0')
    if (!root)
      return wanted

    const rootSse = computeScreenSpaceError(root.bounds, cameraPosition, screenHeight, fov)
    queue.push({ node: root, sse: rootSse })

    while (queue.length > 0) {
      // Pop highest SSE entry
      let maxIdx = 0
      for (let i = 1; i < queue.length; i++) {
        if (queue[i]!.sse > queue[maxIdx]!.sse) {
          maxIdx = i
        }
      }
      const entry = queue[maxIdx]!
      queue[maxIdx] = queue.at(-1)!
      queue.pop()

      const { node, sse } = entry

      // Frustum cull
      if (!intersectsFrustum(node.bounds, frustumPlanes)) {
        continue
      }

      // Budget check
      if (pointsAccum + node.pointCount > pointBudget)
        continue
      if (wanted.size >= maxActiveTiles)
        continue

      // Accept this node
      wanted.set(node.id, entry)
      pointsAccum += node.pointCount

      // Decide whether to expand children
      if (shouldSplit(sse, node.level, lodConfig)) {
        const childIds = getChildIds(node)
        for (const childId of childIds) {
          const child = this.hierarchy.get(childId)
          if (!child)
            continue
          const childSse = computeScreenSpaceError(child.bounds, cameraPosition, screenHeight, fov)
          queue.push({ node: child, sse: childSse })
        }
      }
    }

    return wanted
  }

  // -----------------------------------------------------------------------
  // Eviction — remove tiles not in the wanted set, farthest first
  // -----------------------------------------------------------------------

  private evict(
    wanted: Map<string, TraversalEntry>,
    view: ViewState,
  ): void {
    const toEvict: Array<{ id: string, distance: number }> = []

    for (const [id, tile] of this.tiles) {
      if (tile.status !== 'loaded')
        continue
      if (wanted.has(id))
        continue

      const dist = distanceToBoundsCenter(
        view.cameraPosition,
        tile.node.bounds,
      )
      toEvict.push({ id, distance: dist })
    }

    // Evict farthest first
    toEvict.sort((a, b) => b.distance - a.distance)

    for (const { id } of toEvict) {
      const tile = this.tiles.get(id)
      if (!tile)
        continue
      tile.status = 'evicted'
      tile.data = null
      this.tiles.delete(id)
      this.inFlight.delete(id)
      this.callbacks.onTileEvicted(id)
    }
  }

  // -----------------------------------------------------------------------
  // Request loads for wanted tiles that aren't loaded or in-flight
  // -----------------------------------------------------------------------

  private requestLoads(wanted: Map<string, TraversalEntry>): void {
    // Sort by SSE descending so high-priority tiles are requested first
    const entries = Array.from(wanted.entries())
    entries.sort((a, b) => b[1].sse - a[1].sse)

    for (const [id, entry] of entries) {
      if (this.inFlight.has(id))
        continue

      const existing = this.tiles.get(id)
      if (existing && existing.status === 'loaded')
        continue

      this.loadTile(entry.node, entry.sse)
    }
  }

  private loadTile(node: OctreeNode, sse: number): void {
    const { id } = node

    // Mark as loading
    this.tiles.set(id, {
      node,
      status: 'loading',
      data: null,
      screenSpaceError: sse,
      distanceToCamera: 0,
    })
    this.inFlight.add(id)

    const payload: DecodeTilePayload = {
      file: this.datasetMeta.file,
      nodeId: id,
      level: node.level,
      byteOffset: node.byteOffset,
      byteSize: node.byteSize,
      pointCount: node.pointCount,
      bounds: node.bounds,
      pointFormat: this.datasetMeta.pointFormat,
      pointRecordLength: this.datasetMeta.pointRecordLength,
      scale: this.datasetMeta.scale,
      offset: this.datasetMeta.offset,
    }

    this.decode(payload)
      .then((data) => {
        if (this.disposed)
          return

        this.inFlight.delete(id)
        const tile = this.tiles.get(id)
        if (!tile || tile.status === 'evicted')
          return

        // Stamp adaptive spacing: rootSpacing / 2^level
        data.spacing = this.rootSpacing / 2 ** node.level

        tile.status = 'loaded'
        tile.data = data
        this.callbacks.onTileLoaded(id, data)
      })
      .catch(() => {
        this.inFlight.delete(id)
        this.tiles.delete(id)
      })
  }
}

// ---------------------------------------------------------------------------
// Dataset metadata needed by the scheduler to build decode payloads
// ---------------------------------------------------------------------------

export interface DatasetMeta {
  file: File
  pointFormat: number
  pointRecordLength: number
  scale: [number, number, number]
  offset: [number, number, number]
}

/** Compute the 3D diagonal length of a bounding box */
function boundsDiagonal(b: Bounds): number {
  const dx = b.max[0] - b.min[0]
  const dy = b.max[1] - b.min[1]
  const dz = b.max[2] - b.min[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}
