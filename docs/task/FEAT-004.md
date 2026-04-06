# FEAT-004 Tile decode Worker

- **status**: done
- **priority**: P1
- **owner**: roy
- **createdAt**: 2026-04-04 01:30

## Description

Implement a Web Worker that:
1. Receives a node ID + attribute request
2. Reads the corresponding byte range from the COPC file
3. Decompresses LAZ data via laz-perf WASM
4. Extracts position (XYZ), color (RGB), intensity, classification into typed arrays
5. Returns data as Transferable buffers

Worker communication via typed message protocol with requestId.

## ActiveForm

Building tile decode Worker

## Dependencies

- **blocked by**: FEAT-003
- **blocks**: FEAT-005, FEAT-006

## Notes

Use 2-4 decode Worker instances for parallelism. Pre-init laz-perf WASM on Worker startup.
