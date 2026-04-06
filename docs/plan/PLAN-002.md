# PLAN-002 Browser point cloud viewer — pure client-side

- **status**: draft
- **createdAt**: 2026-04-04 01:30
- **approvedAt**: (pending)
- **relatedTask**: FEAT-002 ~ FEAT-013

## Context

Based on `docs/browser-copc-development-plan.md`. Target: a pure client-side (no server) large point cloud viewer in the browser. Data files are ship scans — hull (~1.34 GB), deck (~386 MB), engine (~372 MB), salon (~451 MB).

### Library Landscape (researched 2026-04)

| Need | Library | Notes |
|------|---------|-------|
| COPC parsing | `copc` (copc.js) | TypeScript, reads COPC octree hierarchy + nodes via byte ranges from a Getter abstraction |
| LAZ decompression | `laz-perf` | WASM (Emscripten), browser-native, used by copc.js internally |
| LAS/LAZ reading | **Custom parser** | `@loaders.gl/las` does NOT support LAS v1.3+, unusable. Must write custom LAS 1.2–1.4 parser + `laz-perf` for LAZ |
| Rendering | Three.js + custom ShaderMaterial | WebGL2 for Phase 1; WebGPU as future option |
| Octree/LOD | COPC native octree + custom builder for LAS | No existing in-browser LAS→octree library; must implement |

### Architecture (6 layers)

```
┌─────────────────────────────────────────────────────────────┐
│                    React UI (shadcn/ui)                      │
│  file-opener · toolbar · color-picker · settings · status   │
├─────────────────────────────────────────────────────────────┤
│                  Render & Interaction Layer                   │
│  Three.js WebGL2 · custom shaders · tile-based Points       │
│  color modes (uniform) · selection overlay · GPU picking     │
├─────────────────────────────────────────────────────────────┤
│                   Client Tile Scheduler                      │
│  view frustum culling · LOD policy · point budget            │
│  progressive loading · node eviction                         │
├─────────────────────────────────────────────────────────────┤
│                     Worker Layer                             │
│  metadata · decode (×2-4) · indexing · selection · export    │
├──────────────────────┬──────────────────────────────────────┤
│  Metadata & Index    │         Local Cache Layer             │
│  COPC hierarchy      │  OPFS (tile data, hierarchy)         │
│  LAS local octree    │  IndexedDB (metadata, edit log)      │
├──────────────────────┴──────────────────────────────────────┤
│                    File Access Layer                          │
│  File System Access API · drag-drop · <input type="file">   │
│  type detection (COPC vs LAS vs LAZ) · DatasetDescriptor    │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow — COPC Path (Phase 1)

```
User opens .copc.laz file
  → File Access Layer detects COPC
  → Metadata Worker reads VLRs, hierarchy pages via byte-range slicing
  → Hierarchy tree built in memory (lightweight — only node metadata)
  → Scheduler evaluates camera → requests visible nodes at appropriate LOD
  → Decode Worker(s) read byte ranges, laz-perf decompress → Float32Array positions + attributes
  → Transferable post back to main thread
  → Renderer creates/updates BufferGeometry per tile
  → Shader renders with current color mode uniform
  → Camera moves → scheduler re-evaluates → evict far tiles, load near tiles
```

### Data Flow — LAS/LAZ Path (Phase 2)

```
User opens .las/.laz file
  → File Access Layer detects LAS/LAZ, reads header
  → Progress UI: "Indexing — first open may take a few minutes"
  → Indexing Worker scans all points sequentially:
      - Spatial subdivision into octree cells
      - Subsample for LOD levels
      - Write node data chunks to OPFS
      - Write hierarchy metadata to OPFS
  → On completion: unified DatasetDescriptor, same as COPC path
  → Scheduler + Decoder + Renderer operate identically to COPC
  → Re-open same file: detect OPFS cache → skip indexing, instant browse
```

### Worker Communication Protocol

```typescript
// Main → Worker
interface WorkerRequest {
  requestId: string
  type: string          // e.g. "decode-tile", "parse-metadata"
  payload: unknown
}

// Worker → Main
interface WorkerResponse {
  requestId: string
  type: "result" | "progress" | "error"
  payload: unknown
  transfer?: ArrayBuffer[]  // Transferable list
}
```

Rules:
- All large typed arrays sent as `Transferable` (zero-copy)
- Progress messages for long operations (indexing, export)
- Cancellation via `AbortController` signal or dedicated cancel message

### Unified Data Types

```typescript
interface DatasetDescriptor {
  id: string                    // hash of file name + size + modification time
  sourceFormat: "copc" | "las" | "laz"
  fileName: string
  fileSize: number
  pointCount: number
  pointFormat: number           // LAS point data record format
  bounds: { min: [number, number, number]; max: [number, number, number] }
  scale: [number, number, number]
  offset: [number, number, number]
  attributes: string[]          // e.g. ["position", "rgb", "intensity", "classification"]
  crs?: string                  // WKT or EPSG code if available
  hierarchyDepth: number
  rootNodeId: string
  cached: boolean               // true if OPFS cache exists
}

interface TileData {
  nodeId: string
  level: number
  pointCount: number
  bounds: { min: [number, number, number]; max: [number, number, number] }
  positions: Float32Array       // xyz interleaved, length = pointCount * 3
  colors?: Uint8Array           // rgb interleaved, length = pointCount * 3
  intensity?: Float32Array      // normalized 0-1
  classification?: Uint8Array
}

interface OctreeNode {
  id: string                    // e.g. "0-0-0-0" or COPC key "D-X-Y-Z"
  level: number
  bounds: { min: [number, number, number]; max: [number, number, number] }
  pointCount: number
  childMask: number             // bitmask of which children exist
  byteOffset: number            // offset in source file or cache
  byteSize: number
}
```

## Proposal — 4 Phases

### Phase 1: COPC Browsing (P1 — core foundation)

The minimum viable pipeline: open COPC → parse → schedule → decode → render.

| Task | Title | Details |
|------|-------|---------|
| FEAT-002 | File access layer | Three input methods (File System Access API preferred, drag-drop, input[file]). Read header bytes to detect COPC vs LAS vs LAZ. Output `DatasetDescriptor`. Chromium-first, graceful degradation for Firefox/Safari. |
| FEAT-003 | COPC metadata & hierarchy | Use `copc` library. Wrap File/FileHandle as `Getter` for byte-range reads. Parse VLRs, build hierarchy tree (`Map<string, OctreeNode>`). Run in Metadata Worker. |
| FEAT-004 | Tile decode Worker | Pool of 2-4 Workers. Receive node ID → slice byte range from file → laz-perf WASM decompress → extract position/color/intensity/classification into typed arrays → `Transferable` post back. Pre-init WASM on Worker startup. |
| FEAT-005 | Client tile scheduler | Main-thread scheduler. Inputs: camera matrix, hierarchy tree, point budget. Algorithm: BFS from root, expand nodes whose screen-space error > threshold, respect point budget. Camera idle detection (300ms debounce) triggers refinement. Priority queue by screen-space error. Evict tiles beyond budget. |
| FEAT-006 | Three.js WebGL2 renderer | Each tile = `THREE.Points` with `BufferGeometry` + custom `ShaderMaterial`. Vertex shader: position transform + configurable point size (uniform). Fragment shader: color mode switch (RGB / intensity ramp / height gradient / classification palette / white) via `uniform int colorMode`. Dispose GPU resources on tile eviction. `OrbitControls` for camera. |
| FEAT-007 | Basic viewer UI | React shell with shadcn/ui. File open button + drop zone. Canvas fills viewport. Toolbar: color mode `<Select>`, point size `<Slider>`, point budget `<Slider>`, quality preset (low/med/high). Status bar: point count, tile count, FPS. Progress overlay during parsing. |

**Acceptance criteria**:
- Open a >100 MB COPC file without crashing
- Global overview loads in <3s
- Zoom to local area shows progressively higher detail
- Main thread stays >30 FPS during navigation
- Color mode switch is instant (no CPU rebuild)

### Phase 2: LAS/LAZ Compatibility (P2)

| Task | Title | Details |
|------|-------|---------|
| FEAT-008 | LAS/LAZ parser | Custom implementation (NOT @loaders.gl/las — it does not support LAS >v1.3). Parse LAS 1.2–1.4 public header, VLRs, point data record formats 0–10. LAZ decompression via `laz-perf` WASM. Sequential chunk reader in Worker with configurable chunk size (e.g. 100K points per chunk). |
| FEAT-009 | Local indexing Worker | Dedicated Worker. Scan all points → build octree (spatial midpoint subdivision, max depth ~16). For each node: store point data as binary chunk, subsample for LOD. Write to OPFS via `cache/datasets/{id}/`. Progress reporting (points processed / total). Cancellation support. Target: ~2 min for 500 MB file. |
| FEAT-010 | OPFS cache layer | Directory structure: `cache/datasets/{id}/{metadata.json, hierarchy.bin, tiles/{nodeId}.bin}`. IndexedDB index for dataset registry (id, name, size, date, cache size). Tile read/write API. Eviction: LRU per-dataset, configurable max cache size. Management UI: list cached datasets, sizes, delete button. Detect OPFS support → fall back to IndexedDB-only for metadata. |

**Acceptance criteria**:
- Open a 450 MB `.las` file → indexing progress shown → browse after indexing completes
- Re-open same file → instant browse (cache hit)
- Same renderer/scheduler code works for both COPC and LAS sources

### Phase 3: Selection & Editing (P2)

| Task | Title | Details |
|------|-------|---------|
| FEAT-011 | Selection system | Rectangle selection tool (click-drag). Coarse filter: test tile AABB against selection frustum → skip non-intersecting tiles. Fine filter: Selection Worker projects candidate tile points → test against screen rect → return per-point bitmask. Highlight: selection overlay via separate shader pass (selected points rendered on top with distinct color/size). |
| FEAT-012 | Edit log & undo/redo | Append-only operation log. Operation types: `deleteBySelection(mask)`, `keepByAABB(bounds)`, `filterByClassification(classes)`, `filterByRange(attribute, min, max)`. Each entry: `{type, params, tileIds, timestamp}`. Undo/redo: stack pointer over log. Application: loaded tiles apply log on decode; future-loaded tiles auto-apply. Persist log to IndexedDB (survive reload). |

**Acceptance criteria**:
- Box-select on a 5M+ point scene completes in <1s
- Delete selected → immediate visual update
- Undo restores deleted points
- Navigate to unloaded area → edit log applied on tile load

### Phase 4: Local Export (P3)

| Task | Title | Details |
|------|-------|---------|
| FEAT-013 | Streaming export | Export Worker reads source (COPC nodes or cached LAS chunks). For each chunk: apply edit log filter → write passing points to output. Output format: LAS 1.4 (first target). Write to OPFS temp file in 1 MB chunks, then offer save via File System Access API `showSaveFilePicker()` or blob URL download fallback. Progress: `{phase, pointsProcessed, totalPoints, bytesWritten}`. Cancel support. |

**Acceptance criteria**:
- Export a 200 MB edited dataset without browser OOM
- Progress bar shows real-time status
- Output file is valid LAS readable by CloudCompare

## Key Dependencies

| Package | Version | Purpose | Phase |
|---------|---------|---------|-------|
| `copc` | ^0.0.8 | COPC file parsing + hierarchy | 1 |
| `laz-perf` | ^0.0.7 | WASM LAZ decompression | 1 |
| `three` | ^0.170 | WebGL2 rendering | 1 |
| `@types/three` | ^0.170 | TypeScript types for Three.js | 1 |

No `@loaders.gl/las` — it does not support LAS versions above 1.3. Custom LAS parser required.

## Module Structure

```
apps/web/src/features/viewer/
├── workers/
│   ├── metadata.worker.ts      # COPC/LAS header + hierarchy parsing
│   ├── decode.worker.ts        # tile decode + laz-perf decompress
│   ├── indexing.worker.ts      # LAS→octree conversion (Phase 2)
│   ├── selection.worker.ts     # per-point selection test (Phase 3)
│   └── export.worker.ts        # streaming export (Phase 4)
├── data/
│   ├── types.ts                # DatasetDescriptor, TileData, OctreeNode, WorkerMessage
│   ├── copc-reader.ts          # COPC-specific: wrap copc.js, file-as-getter
│   ├── las-reader.ts           # Custom LAS 1.2-1.4 header + point reader (Phase 2)
│   └── hierarchy.ts            # octree traversal, child enumeration
├── cache/                      # Phase 2
│   ├── opfs-cache.ts           # OPFS read/write for tile data
│   ├── idb-store.ts            # IndexedDB for metadata + edit log
│   └── cache-manager.ts        # eviction, size tracking
├── scheduler/
│   ├── tile-scheduler.ts       # main scheduling loop
│   ├── lod-policy.ts           # screen-space error calculation
│   └── view-state.ts           # camera → frustum → visible set
├── renderer/
│   ├── point-cloud-renderer.ts # manages Three.js scene, camera, controls
│   ├── tile-mesh.ts            # per-tile Points + BufferGeometry lifecycle
│   ├── color-modes.ts          # color mode enum + palette data
│   └── shaders/
│       ├── point.vert.glsl     # position + point size
│       └── point.frag.glsl     # color mode switch
├── editor/                     # Phase 3-4
│   ├── edit-log.ts             # append-only operation log
│   ├── undo-redo.ts            # stack-based undo/redo over log
│   ├── filters.ts              # filter predicates
│   └── export-session.ts       # export orchestration
├── components/
│   ├── viewer-canvas.tsx        # Three.js canvas mount + resize
│   ├── file-opener.tsx          # open dialog + drop zone
│   ├── toolbar.tsx              # top toolbar container
│   ├── color-mode-picker.tsx    # color mode select
│   ├── point-settings.tsx       # point size + budget sliders
│   ├── progress-overlay.tsx     # loading / indexing progress
│   ├── status-bar.tsx           # bottom status: points, tiles, FPS
│   └── cache-manager-dialog.tsx # manage cached datasets (Phase 2)
├── hooks/
│   ├── use-viewer.ts            # viewer lifecycle
│   ├── use-file-access.ts       # File System Access API + fallback
│   ├── use-worker-pool.ts       # manage decode Worker pool
│   └── use-edit-session.ts      # edit log state (Phase 3)
└── store.ts                     # Zustand: UI state (color mode, point size, budget, etc.)
```

## Performance Budget

| Metric | Low | Medium | High |
|--------|-----|--------|------|
| Point budget | 1–2M | 3–5M | 5–10M |
| Active tiles in GPU | ≤50 | ≤150 | ≤300 |
| CPU-side tile cache | 100 MB | 300 MB | 500 MB |
| Decode workers | 2 | 3 | 4 |
| Target FPS | ≥30 | ≥30 | ≥30 |

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| 1 | laz-perf WASM cold start (100-300ms) | Preload WASM in Worker on app init, before user opens file |
| 2 | OPFS browser support (Chromium-only stable) | Target Chromium first; detect + degrade to IndexedDB metadata-only |
| 3 | LAS→octree in-browser for >1 GB files | Show progress + estimated time; allow cancel; cache result to OPFS |
| 4 | Three.js PointsMaterial limitations | Use custom ShaderMaterial from the start; no migration later |
| 5 | Memory pressure from large tile cache | Strict budget enforcement; aggressive eviction; monitor via `performance.memory` |
| 6 | Custom LAS parser correctness | Test against CloudCompare output for multiple point formats (0, 1, 2, 3, 6, 7) |
| 7 | Worker ↔ main thread bottleneck | Transferable arrays only; batch small tiles; avoid structured clone |

## Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **deck.gl** instead of Three.js | Built-in PointCloudLayer, good perf | Heavy bundle, less shader control, harder to customize picking | Rejected — need fine shader control for color modes |
| **Potree** as base | Mature LOD, proven at scale | Requires PotreeConverter (server-side), tightly coupled format | Rejected — need pure client-side, no server |
| **WebGPU** first | Better compute + render performance | Limited browser support (Chrome only stable, Apr 2026) | Deferred — WebGL2 first, WebGPU as future upgrade |
| **@loaders.gl/las** for LAS parsing | Quick integration | Does NOT support LAS >v1.3 | Rejected — our files may be v1.4 |

## Task Dependency Graph

```
FEAT-002 (file access)
  ├─→ FEAT-003 (COPC metadata)
  │     ├─→ FEAT-004 (decode Worker)
  │     │     └─→ FEAT-005 (scheduler)
  │     │           └─→ FEAT-006 (renderer)
  │     │                 └─→ FEAT-007 (UI) ── Phase 1 complete
  │     └─→ FEAT-005
  ├─→ FEAT-008 (LAS/LAZ parser)
  │     └─→ FEAT-009 (indexing Worker) ─┐
  └─→ FEAT-010 (OPFS cache) ───────────┘── Phase 2 complete

FEAT-006 (renderer)
  └─→ FEAT-011 (selection)
        └─→ FEAT-012 (edit log) ── Phase 3 complete
              └─→ FEAT-013 (export) ── Phase 4 complete
```

## Annotations

(none)
