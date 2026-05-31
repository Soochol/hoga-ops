# E2E specs — gating + run instructions

These Playwright specs are committed as the **canonical contract** for E2E coverage. The `replay-smoke` (W5.4) and `multi-tab` (W6.2) specs are now live; the remaining 2 specs (`push-refresh`, `error-states`) still hold `test.skip(true, ...)` pending the gating items listed below.

## Resolved gating

1. ~~**Workarea wiring (Phase 6+ deferred):**~~ **DONE (Wave 5.2)** — `Workarea.tsx` now wires `useSession` → `<ChartStage />` + `<CursorSidebarConnected />`.
2. ~~**`data-pane` attributes:**~~ **DONE (Wave 5.1)** — `ChartStage` wraps each of the 5 panes in `<div data-pane="candle|volume|ratio|fill-strength|quote-totals|volume-profile">`.
3. ~~**`data-card` attributes:**~~ **DONE (Wave 5.4)** — `CursorSidebar`'s `SidebarCard` now emits both `data-testid="card-<key>"` and `data-card="<key>"`.
4. ~~**Backend fixture extension:**~~ **DONE** — `tests/fixtures/tiny_tsv_multi/` ships 005930 and 000660.
5. ~~**`.tab` CSS classes for `multi-tab.spec.ts`:**~~ **DONE (W6.2)** — `Tab.tsx` now emits `class="tab"`, `class="tab active"`, and `class="tab-code"` markers. The spec is unskipped, but still depends on **Remaining gating #1** (Playwright globalSetup with multi-stock seeding, W6.4) before it can pass end-to-end.

## Remaining gating

1. **Backend test data setup script:** the running backend's `data/raw/<date>/<code>/` directories must be seeded with `tests/fixtures/tiny_tsv_multi/<code>/*`, and the parser must be triggered, before the smoke spec can pick a stock. Either add a Playwright `globalSetup` that copies fixtures + hits the parse endpoint, or a `scripts/seed-e2e-fixtures.sh` helper run before `npx playwright test`.
2. **Multi-day stitching for `error-states.spec.ts`:** `[data-segment-status]` requires per-segment loading state on the chart — part of the virtual-axis stitching deferred from Phase 6+.
3. **WebSocket event for `push-refresh.spec.ts`:** `/api/test/add-stockdate?code=...&date=...` appends to the inventory and must broadcast an `inventory_added` event over the WebSocket channel (`ch:'event'`) so the combobox refreshes without a page reload.

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

To run a spec, delete its `test.skip(true, '...')` line at the top of the `describe` block. Specs can be unblocked individually as their gating items land. The `replay-smoke` (W5.4) and `multi-tab` (W6.2) specs are already unskipped but will fail at the stock-pick step until the backend fixture seeding (item 1 in **Remaining gating**) lands.
