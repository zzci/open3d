# Repository Audit Report

- **date**: 2026-04-04
- **scope**: whole repository audit
- **mode**: current repository state

## Repository Audit Summary

No P0 issue was confirmed in the current repository state. Three P1 issues were confirmed: broken root-level quality-gate scripts, a format mismatch between file intake and viewer loading, and exposed selection actions that do nothing. Additional P2 risks exist around worker-pool fault isolation and stale repository documentation. The repository also contains several implemented but currently unconnected modules.

## P0

None.

## P1

### Broken root-level quality-gate entrypoints

The root `package.json` scripts use `bun run --filter apps/web ...`, but the actual workspace package name is `@repo/web`. As a result, running `bun run lint`, `bun run test`, `bun run build`, or `bun run typecheck` from the repository root fails before reaching the app package. This breaks the default validation entrypoint for local development and CI.

Evidence:

- `package.json`
- `apps/web/package.json`

### File intake accepts LAS/LAZ, but viewer loading always assumes COPC

The file-access layer accepts `.las`, `.laz`, and COPC files and produces a `DatasetDescriptor` with `sourceFormat`. The viewer route then unconditionally calls `parseCopc(file)` after storing the descriptor in state. Plain LAS/LAZ files therefore pass intake but fail during viewer initialization, leaving the UI in a half-loaded state with no user-visible error recovery.

Evidence:

- `apps/web/src/features/viewer/hooks/use-file-access.ts`
- `apps/web/src/routes/viewer.tsx`

### Exposed selection actions are still empty stubs

The toolbar renders `Delete` and `Keep` actions when points are selected, but both handlers are empty comments. This is a user-facing correctness issue because the UI advertises editing behavior that is not implemented.

Evidence:

- `apps/web/src/features/viewer/components/toolbar.tsx`

## P2

### Worker crash handling is not isolated per worker

The decode worker pool keeps a global pending-request map. If a single worker crashes, its `onerror` handler rejects and deletes all pending requests, including work assigned to other healthy workers. One worker failure can therefore fan out into visible decode instability across unrelated tiles.

Evidence:

- `apps/web/src/features/viewer/hooks/use-worker-pool.ts`

### Architecture document no longer matches the codebase

`docs/architecture.md` still describes a Python/Open3D/CGAL processing pipeline, while the repository is currently a Bun workspace with a React/Vite/Three.js browser viewer. This is a maintenance risk because it misstates the system under review.

Evidence:

- `docs/architecture.md`

## Dead Code Findings

### Export flow is implemented but not reachable from the current viewer route

The viewer route renders `<Toolbar />` without an `onExport` callback, so the export button is never shown. `ExportDialog` and `ExportSession` are implemented, but no current UI path invokes them. The changelog claims FEAT-013 is complete, but the present route tree does not expose the feature.

Evidence:

- `apps/web/src/routes/viewer.tsx`
- `apps/web/src/features/viewer/components/toolbar.tsx`
- `apps/web/src/features/viewer/components/export-dialog.tsx`
- `apps/web/src/features/viewer/editor/export-session.ts`
- `docs/changelog.md`

### Edit-log, cache-manager, and metadata/indexing worker paths are currently unconnected

`useEditSession`, `CacheManagerDialog`, `metadata.worker.ts`, and `indexing.worker.ts` exist, but no current route or component wiring references them. Static inspection found no active integration path from the viewer route tree into these modules.

Evidence:

- `apps/web/src/features/viewer/hooks/use-edit-session.ts`
- `apps/web/src/features/viewer/cache/cache-manager-dialog.tsx`
- `apps/web/src/features/viewer/workers/metadata.worker.ts`
- `apps/web/src/features/viewer/workers/indexing.worker.ts`

## Dead Code Removal Candidates

- `apps/web/src/features/viewer/components/export-dialog.tsx`
- `apps/web/src/features/viewer/editor/export-session.ts`
- `apps/web/src/features/viewer/hooks/use-edit-session.ts`
- `apps/web/src/features/viewer/cache/cache-manager-dialog.tsx`
- `apps/web/src/features/viewer/workers/metadata.worker.ts`
- `apps/web/src/features/viewer/workers/indexing.worker.ts`

These modules should either be wired into the product path or explicitly removed/parked to reduce false feature signals.

## Needs Runtime Verification

- Plain LAS open flow after viewer-format branching is fixed
- COPC open flow after the same refactor
- Export save/cancel behavior across File System Access API and blob fallback
- Worker-pool recovery behavior when one decode worker crashes
- Large-scene selection latency and edit application on future-loaded tiles

## Coverage Gaps

- Current tests are mostly unit tests; they do not cover end-to-end file-open flows
- No GitHub Actions workflow was found under `.github/workflows`
- Repository-root validation is not covered because the root scripts themselves are broken

## Recommended Next Actions

1. Fix the root workspace filters to target `@repo/web`.
2. Branch viewer loading by `descriptor.sourceFormat` and only commit dataset state after successful parse/index initialization.
3. Remove or hide non-functional `Delete` and `Keep` UI actions until the edit pipeline is wired.
4. Isolate worker-pool request tracking per worker instead of using a single global pending map.
5. Either wire export/edit/cache features end-to-end or remove the currently unreachable entrypoints.
6. Update `docs/architecture.md` to reflect the actual browser-viewer codebase.
7. Add integration tests for COPC open flow and LAS/LAZ open flow.
