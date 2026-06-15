# hoga-ops

Personal local-first tool to capture, store, replay, and inspect Korean stock orderbook + trade data.

Core docs:

- [`CONTEXT.md`](./CONTEXT.md) — glossary and domain language
- [`DESIGN.md`](./DESIGN.md) — frontend design system
- [`frontend/README.md`](./frontend/README.md) — Vite client setup and commands
- [`docs/feature-development-workflow.md`](./docs/feature-development-workflow.md) — feature workflow
- [`docs/architecture-review-2026-05-30.md`](./docs/architecture-review-2026-05-30.md) — architecture review backlog
- [`docs/adr/`](./docs/adr/) and [`docs/superpowers/specs/`](./docs/superpowers/specs/) — decisions and feature specs

## Current status

Backend capture/parsing APIs and the browser frontend are both active. The `/live` workspace is the primary UI for realtime KIS data, historical bundle replay, chart indicators, watchlists, and screener workflows.

## Quickstart

```sh
pip install -e .[dev]
echo "k_=...; n_=..." > .cookie   # paste from your hogaplay session
hoga collect --code 003490 --date 20260519
hoga parse   --code 003490 --date 20260519
hoga serve
```

For frontend development:

```sh
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
cd frontend && npm install && npm run dev
```
