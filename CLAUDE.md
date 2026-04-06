# Open3D Point Cloud Processing

Ship point cloud processing project — extracting fixed structures from LAS scans for renovation design.

## Tech Stack

- **Language**: Python
- **Core Libraries**: Open3D, laspy, numpy, scikit-learn
- **Optional**: CGAL (Python bindings), pyransac3d

## Project Development

This project uses the **PMA workflow** (`/pma`) for task and plan management.

### Three-Phase Workflow

1. **Investigation** — trace code, read docs, claim task in `docs/task/index.md`
2. **Proposal** — present current state, proposal, risks, scope; wait for approval
3. **Implement → Verify → Record** — implement after approval, verify, update changelog

### Key Paths

- Tasks: `docs/task/index.md` → `docs/task/PREFIX-NNN.md`
- Plans: `docs/plan/index.md` → `docs/plan/PLAN-NNN.md`
- Architecture: `docs/architecture.md`
- Changelog: `docs/changelog.md`

## Data

- Point cloud files (`.las`, `.laz`, `.ply`, etc.) are gitignored due to size
- Sample data in `las/` directory (not version controlled)

## Conventions

- Commit messages in English, conventional commits format
- Documentation in English by default
- No AI assistant names in remote-visible content
