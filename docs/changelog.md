# Changelog

## 2026-04-04 01:55 [progress]

FEAT-006: Three.js WebGL2 point cloud renderer. Tile-based rendering with custom ShaderMaterial, 5 color modes (RGB, intensity, height, classification, white) as GPU uniforms — no CPU color rebuild. OrbitControls, ResizeObserver, FPS tracking. Classification palette via 1D texture lookup. Proper GPU resource disposal on tile eviction.

## 2026-04-04 01:20 [progress]

Merged FEAT-003, FEAT-008, FEAT-010:
- FEAT-003: COPC metadata parsing + hierarchy tree + metadata Worker
- FEAT-008: Custom LAS/LAZ parser (LAS 1.2-1.4, point formats 0-10) + laz-perf WASM + tests
- FEAT-010: OPFS cache layer + IndexedDB registry + LRU eviction + cache manager dialog

## 2026-04-04 01:05 [progress]

FEAT-002 merged: file access layer with File System Access API, drag-drop, LAS header parsing, COPC/LAZ/LAS detection, DatasetDescriptor types.

## 2026-04-04 01:00 [progress]

Web frontend project scaffolded: React 19 + TypeScript + Vite 6 + TanStack Router + TanStack Query + Zustand + shadcn/ui + Tailwind CSS v4. Monorepo with bun workspaces. All quality gates pass (lint, typecheck, build).

## 2026-04-04 00:00 [progress]

Project initialized with PMA workflow. Created task/plan tracking, architecture doc, and CLAUDE.md.
