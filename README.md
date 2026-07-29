# hoga-ops

Personal local-first tool to capture, store, and replay Korean stock orderbook + trade data from hogaplay.com and KIS.

See [`CONTEXT.md`](./CONTEXT.md) for the glossary, [`DESIGN.md`](./DESIGN.md) for frontend UI rules, [`CHANGELOG.md`](./CHANGELOG.md) for release history, [`docs/adr/`](./docs/adr/) for architecture decisions, and [`docs/superpowers/specs/`](./docs/superpowers/specs/) / [`docs/superpowers/plans/`](./docs/superpowers/plans/) for design specs and implementation plans.

## Access model — read this before exposing the server

**This API has no authentication.** That is a deliberate, recorded decision
([ADR-0036](./docs/adr/0036-local-deployment-no-resource-caps.md): hoga-ops is a
**local single-user tool**), not an oversight. The security boundary is the
loopback bind: `hoga serve` hardcodes `host="127.0.0.1"` and deliberately exposes
no `--host` option.

**Do not bind it to a non-loopback address.** Anyone who can reach the port can
enqueue captures with your hogaplay cookie and KIS quota, stop live collection
mid-session (hogaplay retains only ~18h, so the morning is then lost for good),
and delete saved views and layout presets — all without credentials.

Browser-initiated cross-origin state changes are blocked separately by
`hoga/api/origin_guard.py`, because CORS does **not** stop them: Starlette only
rejects on preflight, and several routes take no parameters at all, so a form
POST from any page reaches the handler with no preflight. That guard is not
authentication — it only stops *browsers*; `curl` and scripts pass through by
design.

## Current status

The backend exposes capture/replay APIs plus `/live` KIS-backed endpoints. The Vite frontend is wired for replay, watchlists, screeners, heatmap, and live chart workflows, including the `/live` investor trend estimate sidebar card.

## Quickstart

```sh
pip install -e .[dev]
echo "k_=...; n_=..." > .cookie   # paste from your hogaplay session
cp .env.example .env              # add KIS keys for live market data
hoga collect --code 003490 --date 20260519
hoga parse   --code 003490 --date 20260519
hoga serve
```

For frontend development:

```sh
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
cd frontend
npm install
npm run dev
```

## Live index checks

`/live` representative index charts use `/api/live/index-candles` for `1m`, `3m`, `5m`, `10m`, `15m`, `30m`, `D`, `W`, and `M` candles. Index daily candles are fetched in 3-month windows and cached in memory; index minute candles cache exact repeated requests, while fetch depth is limited by the KIS source unit available for each timeframe.

With the backend running, measure index candle fetch behavior from the repo root:

```sh
node scripts/measure_index_daily_cold_fetch.mjs
HOGA_TIMEFRAMES=1m,3m,5m,10m,15m,30m node scripts/measure_index_minute_fetch_depth.mjs
```

Both scripts default to `http://127.0.0.1:8000`; override with `HOGA_API_BASE` when the API is on another port. Use `HOGA_FROM` / `HOGA_TO` to change the date range, `HOGA_STOCKS` / `HOGA_INDICES` for the daily comparison set, and `HOGA_INDEX` / `HOGA_TIMEFRAMES` for the minute-depth probe.
