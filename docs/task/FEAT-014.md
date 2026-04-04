# FEAT-014 Streaming multi-pass indexing for large LAS files

> Priority: P1 | Status: Pending | Created: 2026-04-04

## Problem

Current `indexing.worker.ts` loads ALL points into memory before building the octree. For a 10GB LAS file (~200M points), peak memory is ~5.5GB in a single Worker, causing OOM:

| Buffer | Size |
|--------|------|
| positions (Float32Array, N×3) | 2.4 GB |
| intensity (Float32Array, N) | 0.8 GB |
| colors (Uint8Array, N×3) | 0.6 GB |
| indices (Uint32Array, N) | 0.8 GB |
| tempIndices (subdivide) | 0.8 GB |
| **Total peak** | **~5.5 GB** |

Additionally, several LAS attributes are decoded but discarded (return_number, gps_time), and others are not decoded at all (NIR, scan_angle, number_of_returns, user_data, point_source_id, classification_flags, scanner_channel).

## Goal

Replace the all-in-memory indexer with a **multi-pass recursive chunking** approach where memory usage is bounded by the size of a single octree node, not total file size. Also complete attribute coverage so no LAS data is lost during indexing.

## Approach — Multi-Pass Recursive Chunking (Plan B)

### Core idea

Instead of loading all points and sorting them in memory, scan the file multiple times, narrowing the spatial region each time:

```
Pass 0: scan entire file → count points per top-level octant (8 bins)
Pass 1: for each octant with > MIN_LEAF_POINTS, scan again → count sub-octants
  ...recurse until leaf...
Pass N: at leaf level, read actual point data → encode tile → write OPFS
```

### Phases

#### Phase 1 — Streaming octant counter

New function: `countOctants(file, header, bounds, depth) → Map<octantKey, count>`

- Reads file in chunks via `File.slice()` (lazy, zero-copy reference)
- For each chunk, decodes only XYZ (12 bytes per point for uncompressed, or via laz-perf for LAZ)
- Classifies each point into the target octant at the given depth
- Returns per-octant point counts without storing any point data
- Memory: O(8^depth_delta) counters ≈ negligible

#### Phase 2 — Recursive subdivision driver

```
function buildNodeRecursive(file, header, nodeBounds, nodeId, depth, maxDepth):
  if depth >= maxDepth or count <= MIN_LEAF_POINTS:
    → go to Phase 3 (leaf read)
  
  counts = countOctants(file, header, nodeBounds, 1)  // 1-level split
  
  for each non-empty child octant:
    buildNodeRecursive(file, header, childBounds, childId, depth+1, maxDepth)
```

At each recursion level, only one `countOctants` scan is active — memory is constant.

#### Phase 3 — Leaf tile materialization

When a node is a leaf (count <= MIN_LEAF_POINTS or depth >= maxDepth):

- Scan the file one more time for this spatial region
- Decode ALL attributes for points within bounds
- Encode tile binary → write to OPFS
- Memory: O(leafSize) ≈ a few MB max

#### Phase 4 — LOD sample generation for inner nodes

After children are written, inner nodes need LOD samples:

- Option A: Re-scan and subsample (consistent with current stride approach)
- Option B: Read back child tiles and merge-sample (avoids extra file scan)

Prefer Option B — read from OPFS cache is fast and avoids redundant I/O.

### I/O analysis

- Worst case: each point is read `depth` times during counting passes
- Depth 14 (200M points) → 14 passes over 10GB = 140GB logical I/O
- But `File.slice().arrayBuffer()` benefits from OS page cache after first read
- Realistic wall time: dominated by first pass (cold), subsequent passes hit cache
- LAZ path: each pass requires full decompression — consider caching decoded XYZ positions in OPFS after first pass to avoid repeated decompression

### LAZ optimization

LAZ files cannot be randomly accessed — decompression is sequential. Two strategies:

1. **First-pass XYZ cache**: Decode once, write a compact XYZ-only binary to OPFS (~12 bytes/point = 2.4GB for 200M points). Subsequent counting passes read from this cache with `File.slice()`.
2. **Single-pass multi-level counting**: In one sequential decompression pass, classify each point into ALL levels simultaneously (Morton code), building the full octant count tree. Then materialize leaves in a second pass.

Strategy 2 is more memory-efficient (counts only, ~few MB) and requires only 2 full decompression passes total.

## Attribute completeness

### Currently missing from decode

| Attribute | LAS Formats | Bytes | Action |
|-----------|-------------|-------|--------|
| number_of_returns | all | part of flag byte | Decode from existing flag byte |
| scan_angle_rank | 0-5 | 1 (int8) | Add decode |
| scan_angle | 6-8 | 2 (int16, scaled ×0.006°) | Add decode |
| user_data | all | 1 (uint8) | Add decode |
| point_source_id | all | 2 (uint16) | Add decode |
| NIR | 8 | 2 (uint16) | Add format 8 decode path |
| classification_flags | 6-8 | part of flag byte | Extract from LAS 1.4 flag byte |
| scanner_channel | 6-8 | part of flag byte | Extract from LAS 1.4 flag byte |

### Currently decoded but not stored in tiles

| Attribute | Action |
|-----------|--------|
| return_number | Add to TileData + tile binary format |
| gps_time | Add to TileData + tile binary format |

### Tile binary format changes

Extend `encodeTileBinary` / `decodeTileBinary` with new flag bits:

```
FLAG_HAS_COLOR          = 0x01  (existing)
FLAG_HAS_INTENSITY      = 0x02  (existing)
FLAG_HAS_CLASSIFICATION = 0x04  (existing)
FLAG_HAS_RETURN_NUMBER  = 0x08  (new)
FLAG_HAS_GPS_TIME       = 0x10  (new)
FLAG_HAS_SCAN_ANGLE     = 0x20  (new)
FLAG_HAS_NIR            = 0x40  (new)
FLAG_HAS_EXTRA          = 0x80  (new: user_data, point_source_id, etc.)
```

### TileData interface changes

```typescript
interface TileData {
  // ... existing fields ...
  returnNumber?: Uint8Array
  gpsTime?: Float64Array
  scanAngle?: Float32Array
  nir?: Uint16Array
  userData?: Uint8Array
  pointSourceId?: Uint16Array
}
```

## Implementation order

1. **Attribute completeness** — extend decode + TileData + tile binary (low risk, independent)
2. **Multi-pass counter** — `countOctants()` + recursive driver (core change)
3. **Leaf materializer** — bounded-memory tile writer
4. **LOD inner node builder** — merge-sample from child tiles
5. **LAZ two-pass optimization** — single-pass Morton counting
6. **Progress reporting** — update UI with per-phase progress
7. **Cache invalidation** — detect and handle format version changes in OPFS cache

## Risks

| Risk | Mitigation |
|------|------------|
| LAZ sequential-only decompression | Two-pass strategy with Morton counting |
| I/O amplification (14× for deep trees) | OS page cache + optional XYZ cache in OPFS |
| OPFS storage quota for XYZ cache | Check quota before caching; fallback to multi-pass |
| Backward compatibility of tile format | Version field in tile binary header |

## Success criteria

- 10GB LAS file indexes successfully with < 500MB Worker memory
- All LAS point format 0-8 attributes fully preserved in tiles
- Existing COPC path unaffected
- Progress UI shows meaningful per-phase feedback
- Indexed result produces identical rendering to current approach
