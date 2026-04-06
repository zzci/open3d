# FEAT-007 Basic viewer UI

- **status**: completed
- **priority**: P1
- **owner**: claude
- **createdAt**: 2026-04-04 01:30

## Description

Build the React UI shell around the 3D viewer:

1. File open dialog — button + drag-drop zone (with File System Access API support)
2. Camera controls — orbit, pan, zoom (delegated to Three.js OrbitControls)
3. Toolbar — color mode picker, point size slider, point budget slider, quality preset (low/medium/high)
4. Status bar — loaded point count, active tiles, FPS, dataset info
5. Progress overlay — shown during file parsing and COPC hierarchy loading

## ActiveForm

Building viewer UI components

## Dependencies

- **blocked by**: FEAT-006
- **blocks**: (none — Phase 1 complete)

## Notes

Use shadcn/ui for controls (Button, Slider, Select, Dialog). Canvas fills remaining viewport.
