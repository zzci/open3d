# FEAT-006 Three.js WebGL2 point cloud renderer

- **status**: done
- **priority**: P1
- **owner**: roy
- **createdAt**: 2026-04-04 01:30
- **completedAt**: 2026-04-04

## Description

Build a tile-based point cloud renderer using Three.js and WebGL2:

1. Tile-based rendering — each visible tile owns its own attribute buffers (BufferGeometry)
2. Custom shaders — color mode as uniform (RGB, intensity, height, classification, white), no CPU-side color rebuild
3. Point size control — adjustable via uniform, screen-space sizing option
4. Selection overlay — separate render pass or mask for highlighted points
5. GPU picking — color-based picking for point identification

Camera: OrbitControls with smooth zoom and pan.

## ActiveForm

Building Three.js renderer with shader-based color modes

## Dependencies

- **blocked by**: FEAT-005
- **blocks**: FEAT-007

## Notes

Use ShaderMaterial, not PointsMaterial. Each tile = one Points object with its own BufferGeometry.
Dispose tile GPU resources on eviction to prevent memory leaks.
