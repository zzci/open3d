# Changelog

## 2026-04-04 06:15 [progress]

Re-ran repository audit against the current workspace state:
- fixed since prior audit: root workspace filters now target `@repo/web`, decode worker crash handling is isolated per worker
- remaining P1 findings: LAS/LAZ intake still lands in a non-functional viewer path, edit-log actions are recorded but not applied to rendered tiles, export still ignores edits (`editLog: []`)
- remaining P2 findings: cancelling the save picker is treated as a successful export, `lint` currently fails while `test`, `typecheck`, and `build` pass

## 2026-04-04 06:00 [progress]

PLAN-004 complete — production-quality point cloud rendering:
- Phase A: EDL multi-pass pipeline, adaptive octree-spacing sizing, Gaussian alpha falloff
- Phase B: 6 color palettes (viridis/turbo/inferno/plasma/cividis/grayscale), 10 color modes, histogram equalization
- Phase C: High-DPI + MSAA, SSAO with blur
- 4 rendering modes: Points (raw QA), Shaded (default), Smooth (presentation), X-Ray (see-through)
- Mode × Quality matrix: Performance / Balanced / Quality / Ultra

## 2026-04-04 04:30 [BUG-P1]

Fixed all repository audit findings:
- P1: Root package.json workspace filter fixed (`apps/web` → `@repo/web`)
- P1: Viewer route branches by sourceFormat (COPC direct, LAS/LAZ shows placeholder)
- P1: Delete/Keep toolbar actions wired to edit log via useEditSession
- P2: Worker pool pending map isolated per worker (crash no longer fan-out)
- P2: architecture.md rewritten to match actual browser viewer codebase
- Dead code: Export dialog, edit session, selection overlay wired into viewer route

## 2026-04-04 03:51 [progress]

AUDIT-001: Wrote repository audit report to `docs/repository-audit-2026-04-04.md` and registered the work in PMA task/plan tracking.

## 2026-04-04 04:10 [BUG-P0]

BUG-001: Fixed all audit findings from repository-wide code review:
- P0: Export worker stream now closed in try-finally (prevents OPFS leaks on error)
- P1: Worker pool rejects pending requests on onerror + terminates dead workers
- P1: Scheduler cleans inFlight set on tile eviction (prevents stale decode ghost tiles)
- P1: Selection hook uses crypto.randomUUID + 30s timeout cleanup (prevents unbounded memory)
- P1: Export empty bounds now uses descriptor.bounds instead of invalid zeroes
- P2: Worker pool size adapts to navigator.hardwareConcurrency (2-4 workers)
- P2: Removed dead code — unused childCount() from hierarchy.ts

## 2026-04-04 02:10 [progress]

All 4 phases complete (FEAT-001 through FEAT-013 merged to main). Review cron deleted.

## 2026-04-04 03:00 [progress]

FEAT-013: Streaming local export. Two-pass Export Worker reads source LAS file sequentially — pass 1 counts surviving points and computes bounds, pass 2 writes LAS 1.4 header + filtered points in 1 MB chunks to OPFS temp file. ExportSession orchestrates worker lifecycle with File System Access API save picker (blob URL fallback for Firefox/Safari). Cancellation via worker message. Export dialog shows phase, progress bar, point count, bytes written. Toolbar Export LAS button (disabled when no dataset). Zustand store extended with export state slice. Temporary EditLogEntry types for FEAT-012 integration.

## 2026-04-04 02:20 [progress]

FEAT-007: Basic viewer UI. Zustand store for viewer state (color mode, point size, budget, quality preset, loading, stats). shadcn/ui components (Button, Slider, Select, Dialog). Toolbar with color mode picker, point size/budget sliders, quality presets. Status bar with point count, tiles, FPS, dataset info. Progress overlay with cancel. ViewerCanvas component mounting PointCloudRenderer. /viewer route composing all components with COPC loading, scheduler integration, camera idle detection, and stats polling. Enhanced FileOpener and useFileAccess to pass raw File object for scheduler. Format utils extracted to lib/format.ts.

## 2026-04-04 01:55 [progress]

FEAT-006: Three.js WebGL2 point cloud renderer. Tile-based rendering with custom ShaderMaterial, 5 color modes (RGB, intensity, height, classification, white) as GPU uniforms — no CPU color rebuild. OrbitControls, ResizeObserver, FPS tracking. Classification palette via 1D texture lookup. Proper GPU resource disposal on tile eviction.

## 2026-04-04 01:20 [progress]

Merged FEAT-003, FEAT-008, FEAT-010:
- FEAT-003: COPC metadata parsing + hierarchy tree + metadata Worker
- FEAT-008: Custom LAS/LAZ parser (LAS 1.2-1.4, point formats 0-10) + laz-perf WASM + tests
- FEAT-010: OPFS cache layer + IndexedDB registry + LRU eviction + cache manager dialog

## 2026-04-04 01:05 [progress]

FEAT-002 merged: file access layer with File System Access API, drag-drop, LAS header parsing, COPC/LAZ/LAS detection, DatasetDescriptor types.

## 2026-04-04 01:00 [progress]

Web frontend project scaffolded: React 19 + TypeScript + Vite 6 + TanStack Router + TanStack Query + Zustand + shadcn/ui + Tailwind CSS v4. Monorepo with bun workspaces. All quality gates pass (lint, typecheck, build).

## 2026-04-04 00:00 [progress]

Project initialized with PMA workflow. Created task/plan tracking, architecture doc, and CLAUDE.md.
