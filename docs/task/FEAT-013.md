# FEAT-013 Streaming local export

- **status**: pending
- **priority**: P3
- **owner**: (unassigned)
- **createdAt**: 2026-04-04 01:30

## Description

Implement streaming export in an Export Worker:

1. Read source file or cached index in chunks
2. Replay edit log to filter points
3. Generate LAS output header
4. Write filtered points in chunks to OPFS or file handle (File System Access API)
5. Progress reporting (% complete, current stage)
6. Cancellation and error recovery
7. Offer download via File System Access API or blob URL fallback

## ActiveForm

Building streaming export system

## Dependencies

- **blocked by**: FEAT-012
- **blocks**: (none — Phase 4 complete)

## Notes

Must never build a single giant Blob. Write chunks directly to OPFS temporary file, then offer save.
First target: LAS output. LAZ/COPC export as stretch goals.
