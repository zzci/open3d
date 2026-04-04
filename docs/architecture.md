# Architecture

## Overview

Pure client-side (no server) browser application for viewing, editing, and exporting large point cloud files from ship LAS scans. Built as a Bun monorepo with React 19, Vite, Three.js WebGL2, and Web Workers.

## System Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    React UI (shadcn/ui)                      │
│  file-opener · toolbar · color-picker · status · export     │
├─────────────────────────────────────────────────────────────┤
│                  Render & Interaction Layer                   │
│  Three.js WebGL2 · custom shaders · tile-based Points       │
│  color modes (uniform) · selection overlay                   │
├─────────────────────────────────────────────────────────────┤
│                   Client Tile Scheduler                      │
│  view frustum culling · LOD policy · point budget            │
│  progressive loading · node eviction                         │
├─────────────────────────────────────────────────────────────┤
│                     Worker Layer                             │
│  metadata · decode (×2-4) · indexing · selection · export    │
├──────────────────────┬──────────────────────────────────────┤
│  Metadata & Index    │         Local Cache Layer             │
│  COPC hierarchy      │  OPFS (tile data, hierarchy)         │
│  LAS local octree    │  IndexedDB (metadata, edit log)      │
├──────────────────────┴──────────────────────────────────────┤
│                    File Access Layer                          │
│  File System Access API · drag-drop · <input type="file">   │
│  type detection (COPC vs LAS vs LAZ) · DatasetDescriptor    │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Category | Technology |
|----------|-----------|
| Framework | React 19 + TypeScript |
| Build | Vite 6 |
| Rendering | Three.js (WebGL2) + custom GLSL shaders |
| Routing | TanStack Router |
| Server state | TanStack Query |
| Client state | Zustand |
| UI | shadcn/ui + Tailwind CSS v4 |
| Point cloud | copc (copc.js), laz-perf (WASM) |
| Package manager | Bun workspaces |
| Lint | ESLint + @antfu/eslint-config |

## File Structure

```
open3d/
├── apps/web/
│   └── src/
│       ├── app/              # Providers, router
│       ├── routes/           # TanStack Router pages
│       │   ├── __root.tsx
│       │   ├── index.tsx
│       │   └── viewer.tsx    # Main viewer page
│       ├── features/viewer/
│       │   ├── data/         # Types, COPC reader, LAS parser, hierarchy, octree builder
│       │   ├── workers/      # Web Workers (metadata, decode, indexing, selection, export)
│       │   ├── cache/        # OPFS + IndexedDB cache layer
│       │   ├── scheduler/    # Tile scheduler, LOD policy, view state
│       │   ├── renderer/     # Three.js renderer, tile mesh, shaders, color modes
│       │   ├── editor/       # Edit log, undo/redo, filters, export session, LAS writer
│       │   ├── components/   # UI components (toolbar, file opener, overlays, dialogs)
│       │   ├── hooks/        # React hooks (file access, worker pool, selection, edit session)
│       │   ├── lib/          # Utilities (format helpers)
│       │   └── store.ts      # Zustand state
│       └── shared/           # shadcn/ui components, theme, utils
├── packages/
│   ├── config/               # Shared TypeScript configs
│   └── shared/               # Cross-workspace types
├── las/                      # Raw point cloud data (gitignored)
└── docs/                     # PMA task/plan tracking, architecture, changelog
```

## Data

- Point cloud files (`.las`, `.laz`, `.ply`, etc.) are gitignored due to size
- Sample data in `las/` directory (not version controlled)
- Ship scan files: hull (~1.34 GB), deck (~386 MB), engine (~372 MB), salon (~451 MB)
