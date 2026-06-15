# hoga-ops Frontend

React + TypeScript + Vite client for the hoga-ops replay viewer.

See `DESIGN.md` at the repo root for the design system and
`docs/superpowers/designs/2026-05-20-replay-viewer.html` for the approved visual reference.

## Prerequisites

- Node.js 20+ and npm
- Backend running (see "Backend" below) on port 8000 by default

## Setup

```bash
npm install
```

## Common commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR on `http://localhost:5173` |
| `npm run build` | Type-check (`tsc -b`) + production bundle to `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npx vitest run` | Run unit + component tests (vitest, JSDOM) |
| `npx vitest` | Watch mode |
| `npx playwright test` | E2E specs (gated — see `tests/e2e/README.md`) |
| `npm run lint` | ESLint |

## Backend

The backend is a FastAPI app served by uvicorn. From the repo root:

```bash
uv run uvicorn hoga.api.app:app --reload --port 8000
```

This exposes the SSE replay stream the frontend consumes.

## Runtime configuration

The frontend reads `/config.json` at startup to pick up the API base URL.
A default `public/config.json` ships with `{ "apiBaseUrl": "http://localhost:8000" }`.
Override per-deployment by replacing the file in the served `dist/` directory —
no rebuild required.

## Project layout

```
frontend/
  src/
    components/      # presentational React components
    hooks/           # data hooks (SSE, snapshots, etc.)
    store/           # Zustand stores
    api/             # fetch + SSE clients
    tests/           # vitest unit + component tests
  tests/e2e/         # Playwright specs (gated)
  public/config.json # runtime API base URL
```

## Status

The shell, routing, URL state, and data hooks are wired. Several panes
(Workarea, ChartStage, CursorSidebarConnected) exist as components but are
not yet mounted in the live layout — they're scheduled for Phase 11.
