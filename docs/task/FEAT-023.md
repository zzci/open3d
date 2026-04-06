# FEAT-023 Rendering mode system (Points / Shaded / Smooth / X-Ray)

- **status**: pending
- **priority**: P1
- **owner**: (unassigned)
- **createdAt**: 2026-04-04 05:30

## Description

Implement 4 selectable rendering modes as a first-class concept orthogonal to color mode and quality level:

- **Points**: Raw scan visualization. Hard circles, no EDL, fixed sizing. For data QA and noise inspection.
- **Shaded**: Structural depth. Hard circles, EDL on, adaptive sizing. Default mode for navigation and editing.
- **Smooth**: Surface-like appearance. Gaussian splats, EDL on, larger adaptive sizing, alpha blending. For presentations.
- **X-Ray**: See-through layers. Small hard circles, no EDL, additive blending. For interior inspection.

Each mode = a RenderMode config object controlling point shape, EDL, sizing, blend mode, and depth write. Mode switch is instant (uniform + GL state change only, no geometry rebuild).

Mode and quality are independent axes. Mode × Quality matrix defines per-combination parameters (see PLAN-004).

## ActiveForm

Implementing rendering mode system

## Dependencies

- **blocked by**: FEAT-015 (EDL), FEAT-016 (adaptive sizing), FEAT-017 (alpha falloff)
- **blocks**: (none — integrates all Phase A work)

## Notes

This task wires together EDL, adaptive sizing, and alpha falloff into user-facing presets. Must be implemented after Phase A core tasks are done.
