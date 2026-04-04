# FEAT-009 Local indexing Worker for LAS/LAZ

- **status**: pending
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-04-04 01:30

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

## Notes

This is the most compute-heavy operation. For a 1 GB file, expect minutes of processing.
Must show clear progress and allow cancellation. Store results to OPFS so re-open is instant.
