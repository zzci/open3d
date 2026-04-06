# FEAT-011 Selection system

- **status**: in-progress
- **priority**: P2
- **owner**: ai
- **createdAt**: 2026-04-04 01:30

## Description

Implement interactive point selection:

1. Screen rectangle selection tool (click-drag box)
2. Tile-level pre-filtering — quickly identify candidate tiles intersecting selection
3. Per-point test in Selection Worker — project points, test against selection region
4. Return selection result as tile-point mask
5. Visual highlight via selection overlay (separate shader pass or color mask)

## ActiveForm

Building selection system

## Dependencies

- **blocked by**: FEAT-006 (renderer)
- **blocks**: FEAT-012

## Notes

Never project all points on CPU. Use tile AABB for coarse filter, then per-point test only on candidates.
