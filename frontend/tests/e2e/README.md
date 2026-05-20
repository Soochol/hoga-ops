# E2E specs — gating + run instructions

These Playwright specs are committed as the **canonical contract** for E2E coverage. The `replay-smoke` spec is now live (Wave 5.4); the other 3 specs (`multi-tab`, `sse-refresh`, `error-states`) remain `test.skip(true, ...)` pending the gating items listed below.

## Resolved gating

1. ~~**Workarea wiring (Phase 6+ deferred):**~~ **DONE (Wave 5.2)** — `Workarea.tsx` now wires `useSession` → `<ChartStage />` + `<CursorSidebarConnected />`.
2. ~~**`data-pane` attributes:**~~ **DONE (Wave 5.1)** — `ChartStage` wraps each of the 5 panes in `<div data-pane="candle|volume|ratio|fill-strength|intensity|volume-profile">`.
3. ~~**`data-card` attributes:**~~ **DONE (Wave 5.4)** — `CursorSidebar`'s `SidebarCard` now emits both `data-testid="card-<key>"` and `data-card="<key>"`.
4. ~~**Backend fixture extension:**~~ **DONE** — `tests/fixtures/tiny_tsv_multi/` ships 005930 and 000660.

## Remaining gating

1. **Backend test data setup script:** the running backend's `data/raw/<date>/<code>/` directories must be seeded with `tests/fixtures/tiny_tsv_multi/<code>/*`, and the parser must be triggered, before the smoke spec can pick a stock. Either add a Playwright `globalSetup` that copies fixtures + hits the parse endpoint, or a `scripts/seed-e2e-fixtures.sh` helper run before `npx playwright test`.
2. **Multi-day stitching for `error-states.spec.ts`:** `[data-segment-status]` requires per-segment loading state on the chart — part of the virtual-axis stitching deferred from Phase 6+.
3. **SSE test endpoint for `sse-refresh.spec.ts`:** `/api/test/add-stockdate?code=...&date=...` needs to be implemented as a dev-only mutator that appends to the inventory and broadcasts the SSE event.
4. **`.tab` CSS class for `multi-tab.spec.ts`:** `Tab.tsx` currently does not emit `class="tab"` / `class="tab-code"` / `class="tab active"` markers that the spec selects on.

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

To run a spec, delete its `test.skip(true, '...')` line at the top of the `describe` block. Specs can be unblocked individually as their gating items land. The `replay-smoke` spec is already unskipped (Wave 5.4) but will fail at the stock-pick step until the backend fixture seeding (item 1 in **Remaining gating**) lands.
