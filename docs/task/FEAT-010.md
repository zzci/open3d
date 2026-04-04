# FEAT-010 OPFS cache layer

- **status**: pending
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-04-04 01:30

## Description

Implement a local cache layer using OPFS (Origin Private File System):

1. Dataset-isolated directory structure: `cache/datasets/{id}/metadata.json, hierarchy.bin, tiles/, edits.json`
2. Cache index in IndexedDB — track cached datasets, sizes, last access
3. Tile-level read/write — store and retrieve decoded node data
4. Eviction — dataset-level cleanup, capacity-based eviction
5. Cache management UI entry point (list datasets, show sizes, delete)

## ActiveForm

Building OPFS cache layer

## Dependencies

- **blocked by**: FEAT-002
- **blocks**: FEAT-009

## Notes

OPFS is Chromium-stable, Firefox partial. Detect support and fall back to IndexedDB for metadata-only cache.
