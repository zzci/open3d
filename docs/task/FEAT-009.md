# FEAT-009 Local indexing Worker for LAS/LAZ

- **status**: done
- **priority**: P2
- **owner**: roy
- **createdAt**: 2026-04-04 01:30
- **completedAt**: 2026-04-04

## Description

Build an Indexing Worker that converts plain LAS/LAZ into a browsable octree:

1. Sequential scan of all points
2. Spatial subdivision into octree nodes
3. Generate LOD levels (subsampling)
4. Store node data + hierarchy to OPFS cache
5. Output unified metadata compatible with COPC browse path
6. Progress reporting (% complete, estimated remaining time)
7. Cancellation support

## ActiveForm

Building LAS/LAZ local indexing Worker

## Dependencies

- **blocked by**: FEAT-008, FEAT-010
- **blocks**: (none — Phase 2 complete after FEAT-010)

## Implementation

### Files

- `apps/web/src/features/viewer/workers/indexing.worker.ts` — Worker entry point
- `apps/web/src/features/viewer/data/octree-builder.ts` — Pure octree construction logic (testable)
- `apps/web/src/features/viewer/data/octree-builder.test.ts` — 23 unit tests
- `apps/web/src/features/viewer/data/types.ts` — Added `IndexingPayload`, `IndexingProgress`, `IndexingResult`

### Architecture

Two-phase approach with index-based spatial sorting:

1. **Read & Sort** — Stream all points from LAS/LAZ into flat typed arrays, then recursively partition indices into octree cells via midpoint subdivision
2. **Write & LOD** — DFS traversal writes each node to OPFS. Leaf nodes store all points (stride=1), internal nodes subsample (stride=N/50K) for LOD

Target depth adapts to point count: 6 (100K) → 8 (1M) → 10 (10M) → 12 (50M) → 14 (50M+)

### Binary tile format

```
[uint32] pointCount
[uint32] flags (bit0: color, bit1: intensity, bit2: classification)
[float32 * N*3] positions
[uint8 * N*3] colors (optional)
[float32 * N] intensity
[uint8 * N] classification
```

### Worker protocol

- Request: `{ type: "index", payload: { file, datasetId } }`
- Progress: `{ type: "progress", payload: { pointsProcessed, totalPoints, phase, estimatedRemaining } }`
- Phases: parsing → reading → building → writing
- Cancel: `{ type: "cancel" }` — checked at each chunk/node boundary
- Result: `{ type: "result", payload: { descriptor, hierarchy } }`

## Notes

This is the most compute-heavy operation. For a 1 GB file, expect minutes of processing.
Must show clear progress and allow cancellation. Store results to OPFS so re-open is instant.
