# FEAT-017 Smooth point edges with Gaussian alpha falloff

- **status**: done
- **priority**: P1
- **owner**: roy
- **createdAt**: 2026-04-04 05:00

## Description

See PLAN-004 Phase A for full specification.

## ActiveForm

Implementing Smooth point edges with Gaussian alpha falloff

## Dependencies

- **blocked by**: (see PLAN-004 dependency graph)
- **blocks**: (see PLAN-004 dependency graph)

## Notes

### Implementation

- **point.frag.glsl**: Added `uPointShape` uniform (0=circle, 1=gaussian). Gaussian mode uses `alpha = exp(-r2 * 3.0)` with pre-multiplied alpha output `vec4(color * alpha, alpha)`.
- **tile-mesh.ts**: Added `PointShape`/`BlendMode` types, `uPointShape` uniform, `applyBlendMode()` method supporting opaque/alpha/additive modes. Alpha mode uses pre-multiplied blending (src×1 + dst×(1−srcAlpha)).
- **store.ts**: Added `pointShape: 'circle' | 'gaussian'` and `blendMode: 'opaque' | 'alpha' | 'additive'` state with actions.
- **point-cloud-renderer.ts**: Added `updatePointShape()` and `updateBlendMode()` methods that propagate to all tiles. New tiles inherit current blend mode.
