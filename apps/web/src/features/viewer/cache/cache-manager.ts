/**
 * Cache manager — coordinates OPFS tile cache and IDB metadata.
 *
 * Handles:
 *   - OPFS support detection with IDB-only fallback
 *   - Per-dataset size tracking
 *   - LRU eviction at dataset level when exceeding configurable max
 *   - Public list/delete API for UI
 */

import type { DatasetEntry } from './idb-store'
import {

  deleteEditLogs,
  getDataset,
  deleteDataset as idbDeleteDataset,
  listDatasets,
  putDataset,
  touchDataset,
  updateCacheSize,
} from './idb-store'

import {
  getDatasetCacheSize,
  isOpfsAvailable,
  datasetCacheExists as opfsDatasetExists,
  deleteDatasetCache as opfsDeleteDataset,
  readHierarchy as opfsReadHierarchy,
  readMetadata as opfsReadMetadata,
  readTile as opfsReadTile,
  writeHierarchy as opfsWriteHierarchy,
  writeMetadata as opfsWriteMetadata,
  writeTile as opfsWriteTile,
} from './opfs-cache'

export type { DatasetEntry }

const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB

let maxCacheBytes = DEFAULT_MAX_CACHE_BYTES

export function setMaxCacheSize(bytes: number): void {
  maxCacheBytes = bytes
}

export function getMaxCacheSize(): number {
  return maxCacheBytes
}

// --- Tile operations ---

export async function cacheTile(
  datasetId: string,
  nodeId: string,
  data: ArrayBuffer,
): Promise<void> {
  if (!(await isOpfsAvailable()))
    return

  await opfsWriteTile(datasetId, nodeId, data)
  await touchDataset(datasetId)

  const size = await getDatasetCacheSize(datasetId)
  await updateCacheSize(datasetId, size)

  await evictIfNeeded(datasetId)
}

export async function loadTile(
  datasetId: string,
  nodeId: string,
): Promise<ArrayBuffer | null> {
  if (!(await isOpfsAvailable()))
    return null

  const data = await opfsReadTile(datasetId, nodeId)
  if (data)
    await touchDataset(datasetId)
  return data
}

// --- Metadata operations ---

export async function cacheMetadata(
  datasetId: string,
  metadata: unknown,
): Promise<void> {
  if (await isOpfsAvailable()) {
    await opfsWriteMetadata(datasetId, metadata)
  }
}

export async function loadMetadata<T = unknown>(
  datasetId: string,
): Promise<T | null> {
  if (!(await isOpfsAvailable()))
    return null
  return opfsReadMetadata<T>(datasetId)
}

// --- Hierarchy operations ---

export async function cacheHierarchy(
  datasetId: string,
  data: ArrayBuffer,
): Promise<void> {
  if (!(await isOpfsAvailable()))
    return
  await opfsWriteHierarchy(datasetId, data)
}

export async function loadHierarchy(
  datasetId: string,
): Promise<ArrayBuffer | null> {
  if (!(await isOpfsAvailable()))
    return null
  return opfsReadHierarchy(datasetId)
}

// --- Dataset registration ---

export async function registerDataset(
  entry: Omit<DatasetEntry, 'cacheSize' | 'lastAccess' | 'createdAt'>,
): Promise<void> {
  const now = Date.now()
  await putDataset({
    ...entry,
    cacheSize: 0,
    lastAccess: now,
    createdAt: now,
  })
}

export async function hasDatasetCache(datasetId: string): Promise<boolean> {
  const entry = await getDataset(datasetId)
  if (!entry)
    return false

  if (await isOpfsAvailable()) {
    return opfsDatasetExists(datasetId)
  }

  return false
}

// --- List / delete for UI ---

export async function listCachedDatasets(): Promise<DatasetEntry[]> {
  return listDatasets()
}

export async function deleteCachedDataset(datasetId: string): Promise<void> {
  if (await isOpfsAvailable()) {
    await opfsDeleteDataset(datasetId)
  }
  await deleteEditLogs(datasetId)
  await idbDeleteDataset(datasetId)
}

export async function getTotalCacheSize(): Promise<number> {
  const datasets = await listDatasets()
  return datasets.reduce((sum, d) => sum + d.cacheSize, 0)
}

// --- LRU eviction ---

async function evictIfNeeded(excludeId?: string): Promise<void> {
  let total = await getTotalCacheSize()
  if (total <= maxCacheBytes)
    return

  const datasets = await listDatasets()

  // Sort by lastAccess ascending (oldest first) for LRU
  const sorted = datasets
    .filter(d => d.id !== excludeId)
    .sort((a, b) => a.lastAccess - b.lastAccess)

  for (const dataset of sorted) {
    if (total <= maxCacheBytes)
      break
    total -= dataset.cacheSize
    await deleteCachedDataset(dataset.id)
  }
}
