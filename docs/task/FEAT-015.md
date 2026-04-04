# FEAT-015 Eye-Dome Lighting (EDL) multi-pass rendering

- **status**: done
- **priority**: P1
- **owner**: roy
- **createdAt**: 2026-04-04 05:00
- **completedAt**: 2026-04-04

## Description

Multi-pass rendering pipeline with Eye-Dome Lighting (EDL) post-processing for depth perception enhancement.

## Implementation

### New files
- `renderer/post-processing/shaders/fullscreen.vert.glsl` — fullscreen quad vertex shader
- `renderer/post-processing/shaders/edl.frag.glsl` — EDL computation (8-neighbor dome pattern, log2 depth, configurable radius/strength/exponent)
- `renderer/post-processing/shaders/composite.frag.glsl` — final output with sRGB gamma correction
- `renderer/post-processing/edl-pass.ts` — EDL post-process pass (scene + material + uniforms)
- `renderer/post-processing/render-pipeline.ts` — 3-pass orchestrator (scene FBO → EDL → composite)

### Modified files
- `renderer/point-cloud-renderer.ts` — replaced direct render with pipeline, added EDL control methods
- `store.ts` — added `edlEnabled`, `edlRadius`, `edlStrength`, `edlExponent` state + actions
- `components/toolbar.tsx` — EDL toggle button + strength slider
- `components/viewer-canvas.tsx` — syncs EDL state to renderer

### Pipeline architecture
1. **Pass 1**: Render scene to WebGLRenderTarget with DepthTexture (DEPTH_COMPONENT24)
2. **Pass 2**: EDL shader reads depth, computes per-pixel depth gradient in 8 directions, outputs darkened color
3. **Pass 3**: Composite to screen with sRGB gamma correction

### EDL parameters
- `radius`: 1–5 px (default 2)
- `strength`: 0–1 (default 0.5)
- `exponent`: 0.5–5 (default 1.0)

Bypass mode: when EDL disabled, renders directly to screen (zero overhead).

## Dependencies

- **blocked by**: (none — first task in critical path)
- **blocks**: FEAT-017 (alpha falloff), FEAT-021 (High-DPI + MSAA), FEAT-022 (SSAO)
