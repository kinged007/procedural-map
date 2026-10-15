# AGENTS.md — procedural-map

## Purpose

Deterministic procedural map generator (`fieldwork-map`). Node ESM library with no runtime
dependencies plus a browser map studio (Vite + Canvas). Generates seeded `GameMap` worlds for games.

## How to work in this repo

- Node >= 22.12. Check `package.json` engines.
- Install: `npm install`
- Dev studio: `npm run dev` (Vite, http://127.0.0.1:5173)
- Full quality gate: `npm run check` — runs `format:check` + `lint` + `typecheck` + `tests` + `build:demo`. Same gate runs in CI (`.github/workflows/ci.yml`) and as a pre-commit hook via `core.hooksPath=.githooks`.
- Individual steps: `npm run format`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` (lib + demo).
- Tests use `node --test` over `tests/*.test.mjs` (no extra test runner). Builds lib to `dist/` and studio to `dist-demo/`.
- Enable the local hook after a fresh clone: `git config core.hooksPath .githooks`

## Branch and PR workflow

- Do not push directly to `main`. Create a feature branch and open a PR.
- CI must pass (`npm run check`) before merge.
- Keep commits attributed to `kinged007 <599286+kinged007@users.noreply.github.com>`.

## Skills and conventions

- Read `docs/consuming-maps.md` before changing map output shape or the GameMap schema.
- See `docs/architecture.md`, `docs/generation.md`, `docs/gamemap-schema.md` for design context.
- Prettier + ESLint + `typescript-eslint` are enforced; run `npm run format` to fix style.

## Permissions and scope

- This repo is public and self-contained. Do not publish code derived from the private
  `tenantflex` organisation without written approval. See `docs/03-tenantflex.md` in the
  profile-cleanup workspace for context.
