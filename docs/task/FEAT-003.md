# FEAT-003 COPC metadata and hierarchy parsing

- **status**: pending
- **priority**: P1
- **owner**: (unassigned)
- **createdAt**: 2026-04-04 01:30

## Description

Parse COPC file metadata and octree hierarchy using `copc` (copc.js) library inside a Metadata Worker.

Extract: root node, bounding box, node offsets, point counts, LOD levels, hierarchy page structure.
Build a traversable hierarchy tree that the tile scheduler can query.

## ActiveForm

Parsing COPC metadata and hierarchy

## Dependencies

- **blocked by**: FEAT-002
- **blocks**: FEAT-004, FEAT-005

## Notes

copc.js reads via byte ranges from a Getter abstraction. Wrap File/FileHandle as a Getter.
