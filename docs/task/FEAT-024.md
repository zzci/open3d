# FEAT-024 Add STP/STEP CAD file viewer support

- **status**: pending
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-04-13 21:45

## Description

Add support for loading and rendering STP/STEP CAD files in the browser viewer using `occt-import-js` (WASM-based OpenCascade). STEP files contain B-Rep geometry (solids/surfaces), which must be tessellated into triangle meshes for Three.js rendering.

### Scope

- File detection: recognize `.stp` / `.step` extensions alongside existing LAS/LAZ/COPC
- STEP parsing: use `occt-import-js` to tessellate B-Rep into triangle mesh (vertices, normals, indices, face colors)
- Rendering: Three.js `BufferGeometry` + `MeshStandardMaterial` with per-face color
- UI: reuse existing file opener; show model tree if assembly hierarchy is available
- Limitations: files up to ~100MB (occt-import-js Emscripten memory constraint)

### Acceptance Criteria

- [ ] User can open `.stp` / `.step` files via the same file opener
- [ ] Model renders with correct geometry, normals, and face colors
- [ ] Orbit/zoom controls work on mesh models
- [ ] Assembly hierarchy displayed if present
- [ ] Existing point cloud paths (LAS/LAZ/COPC) unaffected

### Technical Notes

- `occt-import-js` v0.0.23, ~11MB WASM, LGPL-2.1 license
- API: `ReadStepFile(Uint8Array, { linearDeflection, angularDeflection })` returns mesh hierarchy
- Output maps directly to `THREE.BufferGeometry` (positions, normals, indices)
- Parsing should run in a Web Worker to avoid blocking main thread
- Separate rendering path from point cloud (mesh vs points)

## ActiveForm

Adding STP/STEP CAD file viewer support

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

(Implementation notes will be added during development.)
