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
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

This exposes the REST endpoints and WebSocket stream the frontend consumes. The app factory auto-loads `.env` from the repo root.

## Runtime configuration

The frontend reads `/config.json` at startup to pick up the API base URL.
A default `public/config.json` ships with `{ "apiBaseUrl": "http://localhost:8000" }`.
Override per-deployment by replacing the file in the served `dist/` directory —
no rebuild required.

## Project layout

```
frontend/
  src/
    api/             # fetch + SSE clients
    capture/         # capture queue UI and timing views
    chart/           # chart projectors, overlays, drawing, primitives
    heatmap/         # 관심맵 board
    inventory/       # stock-date inventory views
    live/            # /live workspace, bundle assembly, viewport indicators
    pages/           # route-level pages
    state/           # shared Zustand stores
    ui/              # reusable UI primitives
    util/            # shared utilities
    watchlist/       # watchlist panel and persistence
    test/            # vitest helpers
  tests/e2e/         # Playwright specs (gated)
  public/config.json # runtime API base URL
```

## Status

The shell, routing, `/live` chart workspace, watchlist/right-rail, screener, inventory, and capture queue are active. `/live` includes historical bundle loading, KIS realtime updates, viewport-aware overlays, and persisted chart indicator preferences.
