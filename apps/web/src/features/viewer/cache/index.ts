export {
  cacheHierarchy,
  cacheMetadata,
  cacheTile,
  type DatasetEntry,
  deleteCachedDataset,
  getMaxCacheSize,
  getTotalCacheSize,
  hasDatasetCache,
  listCachedDatasets,
  loadHierarchy,
  loadMetadata,
  loadTile,
  registerDataset,
  setMaxCacheSize,
} from './cache-manager'

export { CacheManagerDialog } from './cache-manager-dialog'

export { isOpfsAvailable } from './opfs-cache'
