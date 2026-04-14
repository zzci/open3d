# Open3D - Task List

> Updated: 2026-04-04 03:51

## Usage

Each task is a single line linking to its detail file. All detailed information lives in `docs/task/PREFIX-NNN.md`.

### Format

- [ ] [**PREFIX-001 Short imperative title**](PREFIX-001.md) `P1`

### Status Markers

| Marker | Meaning |
|--------|---------|
| `[ ]`  | Pending |
| `[-]`  | In progress |
| `[x]`  | Completed |
| `[~]`  | Closed / Won't do |

### Priority: P0 (blocking) > P1 (high) > P2 (medium) > P3 (low)

### Rules

- Only update the checkbox marker; never delete the line.
- New tasks append to the end.
- See each `PREFIX-NNN.md` for full details.

---

## Tasks

- [x] [**FEAT-001 Initialize web frontend project**](FEAT-001.md) `P1`
- [x] [**FEAT-002 Implement file access layer**](FEAT-002.md) `P1`
- [x] [**FEAT-003 COPC metadata and hierarchy parsing**](FEAT-003.md) `P1`
- [x] [**FEAT-004 Tile decode Worker**](FEAT-004.md) `P1`
- [x] [**FEAT-005 Client tile scheduler**](FEAT-005.md) `P1`
- [x] [**FEAT-006 Three.js WebGL2 point cloud renderer**](FEAT-006.md) `P1`
- [x] [**FEAT-007 Basic viewer UI**](FEAT-007.md) `P1`
- [x] [**FEAT-008 LAS/LAZ header parsing and decompression**](FEAT-008.md) `P2`
- [x] [**FEAT-009 Local indexing Worker for LAS/LAZ**](FEAT-009.md) `P2`
- [x] [**FEAT-010 OPFS cache layer**](FEAT-010.md) `P2`
- [x] [**FEAT-011 Selection system**](FEAT-011.md) `P2`
- [x] [**FEAT-012 Edit log and undo/redo**](FEAT-012.md) `P2`
- [x] [**FEAT-013 Streaming local export**](FEAT-013.md) `P3`
- [x] [**BUG-001 Fix audit findings from code review**](BUG-001.md) `P0`
- [x] [**AUDIT-001 Record repository audit report**](AUDIT-001.md) `P1`
- [-] [**FEAT-014 Streaming multi-pass indexing for large LAS files**](FEAT-014.md) `P1`
- [x] [**FEAT-015 Eye-Dome Lighting (EDL) multi-pass rendering**](FEAT-015.md) `P1`
- [x] [**FEAT-016 Adaptive point sizing from octree spacing**](FEAT-016.md) `P1`
- [x] [**FEAT-017 Smooth point edges with Gaussian alpha falloff**](FEAT-017.md) `P1`
- [x] [**FEAT-018 Production color palettes**](FEAT-018.md) `P1`
- [x] [**FEAT-019 Extended color modes**](FEAT-019.md) `P1`
- [x] [**FEAT-020 Intensity normalization**](FEAT-020.md) `P2`
- [x] [**FEAT-021 High-DPI rendering and MSAA**](FEAT-021.md) `P2`
- [x] [**FEAT-022 Screen-space ambient occlusion (SSAO)**](FEAT-022.md) `P2`
- [x] [**FEAT-023 Rendering mode system (Points/Shaded/Smooth/X-Ray)**](FEAT-023.md) `P1`
- [-] [**FEAT-024 Add STP/STEP CAD file viewer support**](FEAT-024.md) `P2`
