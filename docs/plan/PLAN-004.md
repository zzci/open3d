# PLAN-004 Production-quality point cloud rendering

- **status**: draft
- **createdAt**: 2026-04-04 05:00
- **approvedAt**: (pending)
- **relatedTask**: FEAT-015 ~ FEAT-022

## Context

Current renderer is a basic `GL_POINTS` pipeline with flat shading and fixed-size round sprites. No depth perception, no surface continuity, no density-adaptive sizing. For a commercial product targeting ship renovation professionals, this is insufficient.

Research (2026-04): Potree, CloudCompare, Cesium all use multi-pass screen-space techniques (EDL, SSAO) and density-aware point sizing. Gaussian splatting is emerging but too costly for real-time editing workflows. EDL + adaptive sizing + proper color maps is the established production baseline.

### Current renderer limitations

| Area | Current | Production standard |
|------|---------|-------------------|
| Depth perception | None | EDL (Eye-Dome Lighting) — multi-pass depth-discontinuity shading |
| Point size | Fixed uniform × distance attenuation, hard 1-64px clamp | Adaptive per-node based on octree spacing; screen-space density compensation |
| Intensity coloring | Single heatmap ramp only | Grayscale direct, viridis, turbo, inferno; histogram equalization option |
| Surface continuity | Isolated circles with hard edges | Gaussian alpha falloff at edges; optional paraboloid splatting |
| Lighting | None | EDL provides lighting-like depth cues without normals |
| Anti-aliasing | Round discard only | Smooth alpha falloff + MSAA + High-DPI aware |
| High-DPI | `devicePixelRatio` capped at 2 | Full DPI-aware with configurable ratio |
| Color ramps | 1 hardcoded heatmap | Multiple selectable palettes (viridis, turbo, grayscale, custom) |
| Intensity normalization | Linear only | Linear + CLAHE (histogram equalization) for local contrast |
| Blending | Opaque only | Depth-weighted blending for overlapping splats |

## Proposal — 8 Tasks in 3 Phases

### Phase A: Core visual quality (critical path)

| Task | Title | Details |
|------|-------|---------|
| FEAT-015 | Eye-Dome Lighting (EDL) | Multi-pass rendering: (1) render point cloud to FBO with depth texture, (2) screen-space EDL pass reads depth neighbors in a dome pattern, computes depth gradient, outputs darkened color. Parameters: `radius` (1-5px, default 2), `strength` (0-100%, default 50%), `exponent` (0.5-5, default 1). Add UI sliders. Reference: CloudCompare/Potree EDL implementation. |
| FEAT-016 | Adaptive point sizing | Per-node point size from octree spacing: `nodeSpacing = rootSpacing / 2^level`. Vertex shader: `pointSize = nodeSpacing * projectionFactor / distance`. Tile-level uniform `uNodeSpacing` set per tile from hierarchy. Eliminate gaps at LOD boundaries. User override multiplier (0.5x-3x). |
| FEAT-017 | Smooth point edges (alpha falloff) | Replace hard circle discard with Gaussian alpha falloff: `alpha = exp(-dot(coord,coord) * 2.0)`. Enable `GL_BLEND` with depth-test. Pre-multiplied alpha blending. This alone makes point clouds look 3x smoother. |

### Phase B: Color and intensity

| Task | Title | Details |
|------|-------|---------|
| FEAT-018 | Production color palettes | Add palette system: grayscale, viridis, turbo, inferno, plasma, cividis. Each palette = 256-entry RGBA Float32 texture (same pattern as classification palette). Shader reads palette via 1D texture lookup. Palette selector in toolbar UI. |
| FEAT-019 | Extended color modes | Add modes: (5) Grayscale intensity, (6) Intensity × Height blend, (7) Return number, (8) Custom palette on any attribute. For grayscale: `color = vec3(intensity)`. For blend: `color = heatmap(height) * intensity`. |
| FEAT-020 | Intensity normalization | Two normalization modes: (a) Linear min-max stretch (current), (b) Histogram equalization — compute intensity histogram in decode Worker, build CDF lookup table, ship as per-tile uniform or texture. CLAHE variant for local contrast. Critical for grayscale LAS where raw intensity range may be narrow. |

### Phase C: Polish and performance

| Task | Title | Details |
|------|-------|---------|
| FEAT-021 | High-DPI and MSAA | Full devicePixelRatio support: `renderer.setPixelRatio(window.devicePixelRatio)` with configurable cap (1x/1.5x/2x). MSAA: `WebGLRenderer({ antialias: true })` or explicit MSAA renderbuffer for EDL FBO. Add quality setting in UI. |
| FEAT-022 | Screen-space ambient occlusion (SSAO) | Optional post-process: sample depth buffer in hemisphere around each pixel, compute occlusion factor. Parameters: `radius` (0.1-2.0 world units), `intensity` (0-1), `samples` (8-32). More expensive than EDL — make it toggleable. For dense point clouds (close-up ship interiors) this adds significant realism. |

## Architecture changes

### Multi-pass rendering pipeline

```
Current:  Scene → WebGLRenderer → canvas (single pass)

Proposed: Scene → FBO (color + depth textures)
            ↓
          EDL pass (screen-space, reads depth texture)
            ↓
          SSAO pass (optional, reads depth texture)
            ↓
          Composite → canvas (full-screen quad)
```

Requires:
- `WebGLRenderTarget` with depth texture attachment
- Full-screen quad shader for post-processing
- Compositor that chains EDL → SSAO → output
- Each post-process pass as a separate `ShaderPass`

### Shader changes

```
point.vert.glsl:
  + uniform float uNodeSpacing     // per-tile octree spacing
  + adaptive point size formula    // spacing × projection / distance
  + existing uPointSize becomes multiplier (user override)

point.frag.glsl:
  + Gaussian alpha falloff         // replace hard discard
  + palette texture lookup         // uColorPalette sampler2D
  + new color modes (5-8)
  + intensity normalization mode   // uniform int uNormMode

edl.frag.glsl (new):
  + depth texture sampling
  + dome pattern neighbor sampling
  + depth gradient → darkness factor
  + uniforms: uEdlRadius, uEdlStrength, uEdlExponent

ssao.frag.glsl (new):
  + hemisphere sampling kernel
  + depth-based occlusion test
  + noise texture for kernel rotation
  + uniforms: uSsaoRadius, uSsaoIntensity, uSsaoSamples

composite.frag.glsl (new):
  + combine color + EDL + SSAO
  + gamma correction
```

### New files

```
apps/web/src/features/viewer/renderer/
  ├── post-processing/
  │   ├── render-pipeline.ts     # multi-pass pipeline orchestration
  │   ├── edl-pass.ts            # Eye-Dome Lighting pass
  │   ├── ssao-pass.ts           # Screen-space ambient occlusion pass
  │   ├── compositor.ts          # final composite to screen
  │   └── shaders/
  │       ├── edl.frag.glsl
  │       ├── ssao.frag.glsl
  │       ├── composite.frag.glsl
  │       └── fullscreen.vert.glsl
  ├── palettes/
  │   ├── palette-registry.ts    # palette definitions + texture builder
  │   └── palette-data.ts        # viridis, turbo, inferno, etc. as Float32Arrays
  └── shaders/
      ├── point.vert.glsl        # modified: adaptive sizing
      └── point.frag.glsl        # modified: alpha falloff, palette modes
```

### UI additions

```
Toolbar additions:
  - EDL toggle + strength slider
  - SSAO toggle + radius/intensity sliders
  - Color palette selector (dropdown)
  - Intensity normalization mode (Linear / Histogram)
  - Point size multiplier slider
  - DPI scaling selector (1x / 1.5x / 2x / Auto)
  - Render quality preset (Performance / Balanced / Quality / Ultra)

Quality presets:
  Performance: EDL off, SSAO off, DPI 1x, budget 2M
  Balanced:    EDL on (default), SSAO off, DPI 1.5x, budget 5M
  Quality:     EDL on, SSAO on (16 samples), DPI 2x, budget 8M
  Ultra:       EDL on, SSAO on (32 samples), DPI native, budget 10M
```

## Task dependency graph

```
FEAT-015 (EDL) ←── requires multi-pass FBO
  ↓
FEAT-017 (alpha falloff) ←── blending + EDL FBO depth
  ↓
FEAT-022 (SSAO) ←── same depth texture from EDL FBO

FEAT-016 (adaptive sizing) ←── independent, vertex shader change
FEAT-018 (palettes) ←── independent, fragment shader + texture
FEAT-019 (color modes) ←── depends on FEAT-018 palettes
FEAT-020 (normalization) ←── depends on FEAT-019 color modes
FEAT-021 (High-DPI + MSAA) ←── depends on FEAT-015 FBO setup
```

**Parallelizable**: FEAT-015 + FEAT-016 + FEAT-018 can start simultaneously.

## Performance budget

| Technique | Cost estimate | Target |
|-----------|--------------|--------|
| EDL pass | 0.5-1ms per frame (1080p) | Always on in Balanced+ |
| SSAO pass (16 samples) | 1-2ms per frame | Quality+ only |
| SSAO pass (32 samples) | 2-4ms per frame | Ultra only |
| Gaussian alpha falloff | ~0 additional (fragment shader) | Always on |
| Adaptive sizing | ~0 additional (vertex shader) | Always on |
| Palette texture lookup | ~0 additional (texture fetch) | Always on |
| High-DPI 2x | 4x fill rate | Quality+ |
| Total frame budget | <16ms (60 FPS) | All presets |

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| 1 | EDL FBO depth precision | Use `DEPTH_COMPONENT24` or `DEPTH_COMPONENT32F`; test with large coordinate offsets (ship scans often have large absolute coords) |
| 2 | Alpha blending + depth sorting | Use additive blending with depth write off for splats, or OIT (order-independent transparency) if artifacts visible |
| 3 | SSAO noise artifacts | Use 4×4 noise texture rotated per pixel; blur pass to smooth |
| 4 | Palette texture filtering | Use `NEAREST` filter to avoid palette bleeding between adjacent colors |
| 5 | High-DPI performance on mid-range GPUs | Default to 1.5x; auto-detect via FPS monitoring and downscale if <30 FPS |
| 6 | Three.js EffectComposer compatibility | Build custom pipeline directly on WebGLRenderTarget rather than using Three's postprocessing addon for better control |

## Alternatives considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Three.js EffectComposer | Less code | Less control over pass ordering, buffer sharing | Rejected — custom pipeline for tighter integration |
| 3D Gaussian Splatting | Photorealistic | 10-50× slower, needs pre-training, not suitable for editing workflow | Rejected for now — revisit for future "preview mode" |
| Paraboloid splatting | Better hole filling | Requires normal estimation per point, adds CPU cost | Deferred — consider after EDL + adaptive sizing |
| WebGPU compute for EDL | Faster | Browser support limited | Deferred — WebGL2 first, WebGPU upgrade path later |

## Annotations

(none)
