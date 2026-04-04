# Architecture

## Overview

Ship point cloud processing system for extracting fixed structures (walls, floors, ceilings, pipes) from LAS scans, removing movable objects (furniture, decorations) for renovation design modeling.

## Data Flow

```
Raw LAS scan
  → Noise removal (outlier/reflection filtering)
  → Structure extraction (RANSAC planes + cylinders)
  → Residual classification (fixed vs movable)
  → Structure-only reconstruction
  → Export (cleaned LAS / mesh)
```

## Processing Domains

### Outdoor (Hull + Deck)

- Hull surface extraction and registration
- Deck structure isolation
- Multi-scan overlap alignment

### Indoor (Engine Room + Salon)

- Wall/floor/ceiling plane detection
- Fixed infrastructure identification (pipes, ducts, built-in cabinets)
- Movable object removal (furniture, curtains, decorations)
- Core rule: truly floating clusters = noise/movable → discard

## Key Libraries

| Library | Role |
|---------|------|
| laspy | LAS file I/O |
| Open3D | Filtering, normals, RANSAC, DBSCAN, Poisson reconstruction |
| CGAL | Efficient RANSAC multi-primitive detection |
| pyransac3d | Lightweight cylinder/plane fitting |
| scikit-learn | DBSCAN clustering |
| numpy | Array operations |

## File Structure

```
open3d/
├── las/              # Raw point cloud data (gitignored)
├── docs/             # Documentation and plans
│   ├── task/         # Task tracking
│   ├── plan/         # Implementation plans
│   ├── architecture.md
│   └── changelog.md
├── CLAUDE.md         # Project conventions
└── .gitignore
```
