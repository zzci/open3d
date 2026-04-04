# FEAT-005 Client tile scheduler

- **status**: pending
- **priority**: P1
- **owner**: (unassigned)
- **createdAt**: 2026-04-04 01:30

## Description

Implement the client-side tile scheduler that manages which octree nodes are loaded/visible:

1. View frustum culling — determine which nodes intersect the camera frustum
2. LOD policy — compute screen-space error per node, decide which LOD to load
3. Point budget — enforce global point limit (1M-10M configurable)
4. Node lifecycle — load/unload/evict tiles based on camera distance and priority
5. Progressive loading — show global low-LOD first, refine on camera idle

## ActiveForm

Building tile scheduler

## Dependencies

- **blocked by**: FEAT-003, FEAT-004
- **blocks**: FEAT-006

## Notes

Scheduler runs on main thread (lightweight). Dispatches decode requests to Workers.
Camera idle detection: debounce 200-300ms after last camera movement.
