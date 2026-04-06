# FEAT-010 OPFS cache layer

- **status**: complete
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-04-04 01:30
- **completedAt**: 2026-04-04

## Description

Implement a local cache layer using OPFS (Origin Private File System):

1. Dataset-isolated directory structure: `cache/datasets/{id}/metadata.json, hierarchy.bin, tiles/{nodeId}.bin`
2. Cache index in IndexedDB — track cached datasets, sizes, last access
3. Tile-level read/write — store and retrieve decoded node data
4. LRU eviction at dataset level when exceeding configurable max (default 2 GB)
5. Cache management dialog (list datasets, show sizes, delete)

## Implementation

| File | Purpose |
|------|---------|
| `apps/web/src/features/viewer/cache/opfs-cache.ts` | OPFS read/write for tile, metadata, and hierarchy binary data |
| `apps/web/src/features/viewer/cache/idb-store.ts` | IndexedDB dataset registry and edit log CRUD |
| `apps/web/src/features/viewer/cache/cache-manager.ts` | Coordinates OPFS + IDB, LRU eviction, public API |
| `apps/web/src/features/viewer/cache/cache-manager-dialog.tsx` | React UI for viewing/deleting cached datasets |
| `apps/web/src/features/viewer/cache/index.ts` | Barrel export |

## Dependencies

- **blocked by**: FEAT-002
- **blocks**: FEAT-009

## Acceptance Criteria

- [x] OPFS support detection with graceful fallback
- [x] Write/read tile binary data by datasetId + nodeId
- [x] Write/read metadata JSON and hierarchy binary
- [x] Dataset cache existence check and deletion
- [x] IDB dataset registry with CRUD operations
- [x] LRU eviction when total cache exceeds configurable max
- [x] Cache manager dialog showing cached datasets with size and delete
- [x] TypeScript compiles without new errors
