# E2E specs — gating + run instructions

These Playwright specs are committed as the **canonical contract** for E2E coverage. All 4 spec files are currently `test.skip(true, ...)` — they will run once the gating items below are wired.

## Gating

1. **Workarea wiring (Phase 6+ deferred):** `ReplayViewer.tsx`'s `<Workarea />` placeholder needs to render `<ChartStage />` (with 5 panes mounted from `useSession()`) + `<CursorSidebarConnected />`. Currently it shows "Workarea — Phase 6+".
2. **`data-pane` attributes:** the 5 chart pane components (`CandlePane`, `VolumePane`, `RatioPane`, `IntensityPane`, `FillStrengthPane`) render `null` — they only register lightweight-charts series. The E2E selectors expect wrapping `<div data-pane="...">` in ChartStage's pane grid.
3. **`data-card` attributes:** `CursorSidebar` currently uses `data-testid="card-orderbook"` etc. — either change the spec selectors to `data-testid` or add `data-card` mirroring.
4. **Per-segment status:** `[data-segment-status]` is referenced by `error-states.spec.ts` but no current code emits per-segment loading state on the chart. This is part of the multi-day virtual axis stitching that will land alongside Workarea wiring.
5. **Backend fixture extension:** Tests need ≥2 captured Stock-Dates (005930, 000660 are referenced). Currently `tests/fixtures/tiny_tsv/` only ships 003490.
6. **SSE test helper:** `/api/test/add-stockdate?code=...&date=...` would mutate the parquet directory at test time. Either implement this dev-only endpoint or have the test runner directly `await fs.mkdir(...)`.

## Run instructions (once gating is satisfied)

```bash
# 1. Start backend with extended fixtures (terminal A)
cd /path/to/hoga-ops
uv run uvicorn hoga.api.app:app --host 0.0.0.0 --port 8000

# 2. Start frontend (terminal B)
cd frontend
npm run dev

# 3. Run Playwright (terminal C)
cd frontend
npx playwright install chromium  # first time only
npx playwright test
```

## Removing the skip

To run a spec, delete its `test.skip(true, '...')` line at the top of the `describe` block. Specs can be unblocked individually as their gating items land.
