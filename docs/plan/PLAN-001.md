# PLAN-001 Initialize web frontend project

- **status**: completed
- **createdAt**: 2026-04-04 00:30
- **approvedAt**: 2026-04-04 00:35
- **relatedTask**: FEAT-001

## Context

Empty project with only docs and LAS data. Need to scaffold a full PMA-Web monorepo. Bun 1.3.11 available.

## Proposal

### 1. Root monorepo setup

- `package.json` with `workspaces: ["apps/*", "packages/*"]`
- `bunfig.toml`
- Root `eslint.config.ts` with `@antfu/eslint-config`
- Root `tsconfig.json`

### 2. packages/config

- `packages/config/tsconfig/base.json` — strict defaults
- `packages/config/tsconfig/react.json` — React JSX, bundler resolution
- `packages/config/package.json`

### 3. packages/shared

- `packages/shared/src/index.ts` — cross-workspace types placeholder
- `packages/shared/package.json`

### 4. apps/web

- Vite 8 + React 19 + TypeScript
- `vite.config.ts` with Tailwind CSS v4 plugin, tsconfig paths, TanStack Router plugin
- `tsconfig.json` extending `@repo/config/tsconfig/react.json`
- PMA-Web folder structure:
  ```
  src/
    app/providers.tsx, router.tsx
    features/
    shared/components/ui/, hooks/, lib/, types/
    styles/theme.css
    index.css
    main.tsx
  index.html
  ```
- Scripts: dev, build, preview, lint, typecheck, test

### 5. shadcn/ui init

- `components.json` configured for `@/shared/` aliases
- Base theme CSS variables in `index.css`

### 6. Quality gates

- `bun run lint` / `bun run typecheck` / `bun run build` all pass

## Risks

- Vite 8 requires compatible plugin versions; will pin to latest stable.

## Scope

~20 new files, all under `apps/`, `packages/`, and root config.

## Alternatives

None — standard PMA-Web scaffolding.

## Annotations

(none)
