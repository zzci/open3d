# FEAT-012 Edit log and undo/redo

- **status**: in-progress
- **priority**: P2
- **owner**: claude
- **createdAt**: 2026-04-04 01:30

## Description

Implement operation-log-based editing (no full point cloud copies):

1. Edit log — append-only operation records (deleteBySelection, keepByAABB, filterByClassification, filterByHeight/Intensity)
2. Each entry: operation type, spatial bounds, camera info, target nodes/conditions, timestamp
3. Undo/redo stack over the log
4. Real-time application — loaded tiles apply log immediately; future-loaded tiles auto-apply
5. Persist edit log to cache (survive page reload)

## ActiveForm

Building edit log and undo/redo system

## Dependencies

- **blocked by**: FEAT-011
- **blocks**: FEAT-013

## Notes

Key principle: edits are operations on the log, not mutations of point arrays.
