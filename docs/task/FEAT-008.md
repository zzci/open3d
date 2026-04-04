# FEAT-008 LAS/LAZ header parsing and decompression

- **status**: pending
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-04-04 01:30

## Description

Implement LAS/LAZ file support:

1. Parse LAS 1.2-1.4 headers — point format, offsets, scales, bounds
2. LAZ decompression via laz-perf WASM in Worker
3. Sequential point reading with configurable chunk size
4. Output same typed array format as COPC decode path

## ActiveForm

Implementing LAS/LAZ parsing and decompression

## Dependencies

- **blocked by**: FEAT-002
- **blocks**: FEAT-009

## Notes

@loaders.gl/las does NOT support LAS versions above 1.3 — cannot be used. Must write custom LAS 1.2–1.4 parser from scratch. Use laz-perf WASM for LAZ decompression. Test against point data record formats 0, 1, 2, 3, 6, 7.
