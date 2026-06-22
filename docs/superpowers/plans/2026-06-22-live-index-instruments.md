# Live Representative Index Instruments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add representative Korean indices to `/live` so they can be opened like stocks, charted through KIS index APIs, and shown without impossible orderbook-derived indicators.

**Architecture:** Introduce `LiveInstrument` as the canonical `/live` subject while keeping `activeCode` as a stock-only compatibility projection. Backend index routes use a fixed representative index registry and separate KIS index parsers/models. Frontend data flow branches at the LivePage session boundary so stock SSE/orderbook hooks never run for index instruments.

**Tech Stack:** FastAPI + pytest backend, React 18 + Zustand + TanStack Query + Vitest frontend, KIS Open API through the existing `KisClient` ingress only.

## Global Constraints

- Do not represent indices as six-digit stock Codes.
- Representative index catalog: KOSPI, KOSDAQ, KOSPI200, KOSDAQ150, plus KRX100/KRX300 only when KIS returns usable data.
- Hidden for index instruments: quote totals, quote ratio, fill strength, day ask peak, day bid peak, live orderbook/trade stream.
- Allowed for index instruments: candles, volume, current-timeframe MA, daily MA, high/low annotations, drawings once keyed by instrument subject.
- Investor panes: KOSPI/KOSDAQ may use market-level investor net data; KOSPI200/KOSDAQ150/KRX100/KRX300 require direct KIS support and must not borrow broader-market data.
- KIS production calls must go through `hoga/live/kis_client.py`; no direct `httpx` calls to KIS outside that ingress.
- Keep `?code=` working for stock deep links; introduce an explicit index deep link instead of overloading `code`.
- V1 disables study-view save for index instruments unless the saved-study contract is migrated to `LiveInstrument`.

---

### Task 1: LiveInstrument Domain, Page Store, and Tab Persistence

**Files:**
- Create: `frontend/src/live/liveInstrument.ts`
- Modify: `frontend/src/state/livePage.ts`
- Modify: `frontend/src/state/liveTabs.ts`
- Modify: `frontend/src/state/liveTabs.test.ts`
- Modify: `frontend/src/state/livePage.test.ts`
- Modify: `CONTEXT.md`

**Interfaces:**
- Produces:
  - `type LiveInstrument = { kind: 'stock'; code: string; label: string } | { kind: 'index'; id: LiveIndexId; label: string }`
  - `type LiveIndexId = 'KOSPI' | 'KOSDAQ' | 'KOSPI200' | 'KOSDAQ150' | 'KRX100' | 'KRX300'`
  - `instrumentToSubjectKey(instrument): 'stock:005930' | 'index:KOSPI'`
  - `instrumentToActiveCode(instrument): string | null`
  - `useLivePageStore.activeInstrument`
  - `useLiveTabsStore.setActiveTabInstrument(instrument)`
- Consumes: existing `setActiveTabCode` and `activeCode` callers remain valid for stock-only paths.

- [ ] **Step 1: Write failing tab migration tests**

Add to `frontend/src/state/liveTabs.test.ts`:

```ts
it('setActiveTabInstrument opens an index tab and clears activeCode projection', () => {
  useLiveTabsStore.getState().setActiveTabInstrument({
    kind: 'index',
    id: 'KOSPI',
    label: 'KOSPI',
  });

  const { tabs, activeTabId } = useLiveTabsStore.getState();
  const active = tabs.find((t) => t.id === activeTabId)!;
  expect(active.instrument).toEqual({ kind: 'index', id: 'KOSPI', label: 'KOSPI' });
  expect(active.code).toBe('');
  expect(active.label).toBe('KOSPI');
  expect(useLivePageStore.getState().activeInstrument).toEqual({
    kind: 'index',
    id: 'KOSPI',
    label: 'KOSPI',
  });
  expect(useLivePageStore.getState().activeCode).toBeNull();
});

it('migrates live.tabs.v1 stock tabs into live.tabs.v2 instruments', () => {
  localStorage.setItem('live.tabs.v1', JSON.stringify({
    activeId: 'tab-a',
    tabs: [{
      id: 'tab-a',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      historicalFromDate: '20260601',
      viewport: null,
    }],
  }));

  const loaded = loadTabs();
  expect(loaded.tabs[0].instrument).toEqual({
    kind: 'stock',
    code: '005930',
    label: '삼성전자',
  });
  expect(loaded.tabs[0].code).toBe('005930');
});
```

- [ ] **Step 2: Run RED**

Run: `cd frontend && npx vitest run src/state/liveTabs.test.ts src/state/livePage.test.ts`

Expected: FAIL because `setActiveTabInstrument`, `activeInstrument`, and `instrument` do not exist.

- [ ] **Step 3: Implement minimal domain and migration**

Create `frontend/src/live/liveInstrument.ts`:

```ts
export type LiveIndexId = 'KOSPI' | 'KOSDAQ' | 'KOSPI200' | 'KOSDAQ150' | 'KRX100' | 'KRX300';

export type LiveInstrument =
  | { kind: 'stock'; code: string; label: string }
  | { kind: 'index'; id: LiveIndexId; label: string };

export function stockInstrument(code: string, label = code): LiveInstrument {
  return { kind: 'stock', code, label };
}

export function indexInstrument(id: LiveIndexId, label = id): LiveInstrument {
  return { kind: 'index', id, label };
}

export function instrumentToActiveCode(instrument: LiveInstrument | null): string | null {
  return instrument?.kind === 'stock' ? instrument.code : null;
}

export function instrumentToSubjectKey(instrument: LiveInstrument): string {
  return instrument.kind === 'stock' ? `stock:${instrument.code}` : `index:${instrument.id}`;
}
```

Update `livePage.ts` to persist `activeInstrument` alongside `activeCode`, where `activeCode` is derived for stocks and `null` for indices. Update `liveTabs.ts` to store `instrument` on each tab, persist `live.tabs.v2`, and migrate `live.tabs.v1` code tabs into stock instruments while preserving the old `code` field for compatibility.

- [ ] **Step 4: Run GREEN**

Run: `cd frontend && npx vitest run src/state/liveTabs.test.ts src/state/livePage.test.ts`

Expected: PASS.

- [ ] **Step 5: Document the domain change**

Update `CONTEXT.md`:

- Add **Live Instrument** and **Representative Index** terms.
- Change **activeCode** to “stock-only projection from activeInstrument”.
- Change Drawing relationship from Code-only to pending `DrawingSubject` if Task 5 implements drawing support.

---

### Task 2: Representative Index Registry and Backend Route Contracts

**Files:**
- Create: `hoga/live/index_registry.py`
- Create: `tests/unit/live/test_index_registry.py`
- Modify: `hoga/live/api.py`
- Create: `tests/api/test_live_indices_routes.py`

**Interfaces:**
- Produces:
  - `LiveIndexId = Literal["KOSPI", "KOSDAQ", "KOSPI200", "KOSDAQ150", "KRX100", "KRX300"]`
  - `RepresentativeIndex(id, label, kis_index_code, investor_scope, enabled_by_default)`
  - `list_representative_indices(include_unverified: bool = False)`
  - `get_representative_index(index_id)`
  - `GET /api/live/indices`

- [ ] **Step 1: Write failing registry tests**

Create `tests/unit/live/test_index_registry.py`:

```py
import pytest

from hoga.live.index_registry import (
    UnknownRepresentativeIndex,
    get_representative_index,
    list_representative_indices,
)


def test_core_indices_are_listed_without_unverified_krx_indices() -> None:
    ids = [idx.id for idx in list_representative_indices()]
    assert ids == ["KOSPI", "KOSDAQ", "KOSPI200", "KOSDAQ150"]


def test_krx_indices_are_present_only_when_unverified_requested() -> None:
    ids = [idx.id for idx in list_representative_indices(include_unverified=True)]
    assert ids == ["KOSPI", "KOSDAQ", "KOSPI200", "KOSDAQ150", "KRX100", "KRX300"]


def test_market_investor_scope_is_only_on_kospi_and_kosdaq() -> None:
    assert get_representative_index("KOSPI").investor_scope == "market"
    assert get_representative_index("KOSDAQ").investor_scope == "market"
    assert get_representative_index("KOSPI200").investor_scope == "none"


def test_unknown_index_is_rejected() -> None:
    with pytest.raises(UnknownRepresentativeIndex):
        get_representative_index("005930")
```

- [ ] **Step 2: Run RED**

Run: `uv run pytest tests/unit/live/test_index_registry.py -q`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement registry**

Create `hoga/live/index_registry.py` with a frozen dataclass and explicit representative list. Use conservative placeholder KIS codes only where verified by KIS docs/probes before merge; if exact KIS codes are not verified, keep `KRX100`/`KRX300` unverified and out of `/indices`.

- [ ] **Step 4: Write failing route test**

Create `tests/api/test_live_indices_routes.py`:

```py
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live.api import build_router


def test_live_indices_route_lists_only_enabled_representative_indices(tmp_path) -> None:
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    res = TestClient(app).get("/api/live/indices")
    assert res.status_code == 200
    body = res.json()
    assert [row["id"] for row in body["indices"]] == ["KOSPI", "KOSDAQ", "KOSPI200", "KOSDAQ150"]
    assert body["indices"][0]["kind"] == "index"
    assert body["indices"][0]["investor_scope"] == "market"
```

- [ ] **Step 5: Run RED**

Run: `uv run pytest tests/api/test_live_indices_routes.py -q`

Expected: FAIL with 404.

- [ ] **Step 6: Implement `/api/live/indices`**

Add Pydantic response models to `hoga/live/api.py` and return the enabled registry rows. Do not perform live KIS probes per request; KRX capability probing belongs in a later explicit cache/probe task.

- [ ] **Step 7: Run GREEN**

Run: `uv run pytest tests/unit/live/test_index_registry.py tests/api/test_live_indices_routes.py -q`

Expected: PASS.

---

### Task 3: KIS Index Candle and Investor Parsers

**Files:**
- Modify: `hoga/live/kis_models.py`
- Modify: `hoga/live/kis_client.py`
- Create: `tests/unit/live/test_kis_index_parsers.py`
- Modify: `hoga/live/api.py`
- Modify: `tests/api/test_live_indices_routes.py`

**Interfaces:**
- Produces:
  - `IndexCandlePoint(t_ms, open, high, low, close, volume)`
  - `IndexCandleFetchResult(points, violations)`
  - `MarketInvestorNetPoint(t_ms, foreign_net, institution_net)`
  - `KisClient.fetch_index_daily_candles(index, from_, to)`
  - `KisClient.fetch_index_minute_candles(index, date, anchor_hhmmss)`
  - `KisClient.fetch_market_investor_net(index, from_, to)`
  - `GET /api/live/index-candles?index_id=&timeframe=&from=&to=`
  - `GET /api/live/index-investor-net?index_id=&from=&to=`

- [ ] **Step 1: Write parser tests from recorded KIS fixtures**

Create `tests/unit/live/test_kis_index_parsers.py` using fixture rows captured from KIS index APIs. The test must assert decimal OHLC values are preserved:

```py
from hoga.live.kis_client import _parse_index_daily_row


def test_parse_index_daily_row_preserves_decimal_index_values() -> None:
    row = {
        "stck_bsop_date": "20260619",
        "bstp_nmix_oprc": "2840.12",
        "bstp_nmix_hgpr": "2861.34",
        "bstp_nmix_lwpr": "2833.20",
        "bstp_nmix_prpr": "2855.67",
        "acml_vol": "450000000",
    }
    point = _parse_index_daily_row(row)
    assert point.open == 2840.12
    assert point.high == 2861.34
    assert point.low == 2833.20
    assert point.close == 2855.67
```

If the actual KIS field names differ, replace the fixture with the observed field names before implementing.

- [ ] **Step 2: Run RED**

Run: `uv run pytest tests/unit/live/test_kis_index_parsers.py -q`

Expected: FAIL with missing parser.

- [ ] **Step 3: Implement parser and models**

Add parser helpers to `kis_client.py` near existing stock candle parsing, but keep index field mapping separate. Reject malformed OHLC rows with explicit violation reasons; do not coerce index prices to `int`.

- [ ] **Step 4: Add route tests with fake KisClient**

Extend `tests/api/test_live_indices_routes.py`:

```py
def test_index_candles_rejects_stock_code_as_index_id(tmp_path) -> None:
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    res = TestClient(app).get("/api/live/index-candles?index_id=005930&timeframe=D&from=20260601&to=20260619")
    assert res.status_code == 422
```

Add a fake client test that returns two `IndexCandlePoint` rows and verifies response shape.

- [ ] **Step 5: Run RED**

Run: `uv run pytest tests/api/test_live_indices_routes.py -q`

Expected: FAIL until routes are implemented.

- [ ] **Step 6: Implement routes**

Add separate validation for `index_id`, `timeframe`, `from`, and `to`; do not call `_validate_past_request` because it enforces `CODE_PATTERN`. Use existing KIS runtime foreground client. Return KIS credential/rate-limit warnings in the same style as `/past-candles`.

- [ ] **Step 7: Run GREEN**

Run: `uv run pytest tests/unit/live/test_kis_index_parsers.py tests/api/test_live_indices_routes.py -q`

Expected: PASS.

---

### Task 4: Frontend Index API Hooks, Search Entries, and Deep Links

**Files:**
- Create: `frontend/src/api/liveIndices.ts`
- Create: `frontend/src/api/liveIndices.test.tsx`
- Modify: `frontend/src/live/LiveSymbolSearch.tsx`
- Modify: `frontend/src/live/LiveSymbolSearch.test.tsx`
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/LivePage.test.tsx`

**Interfaces:**
- Consumes: `/api/live/indices`, `/api/live/index-candles`, `/api/live/index-investor-net`
- Produces:
  - `useLiveIndices()`
  - `useLiveIndexCandles(indexId, timeframe, from, to)`
  - `useLiveIndexInvestorNet(indexId, from, to, enabled)`
  - Search rows with `kind: 'stock' | 'index'`

- [ ] **Step 1: Write failing API hook tests**

Create `frontend/src/api/liveIndices.test.tsx`:

```tsx
it('useLiveIndices maps representative index rows from the backend', async () => {
  server.use(http.get('/api/live/indices', () => HttpResponse.json({
    indices: [{ kind: 'index', id: 'KOSPI', label: 'KOSPI', investor_scope: 'market' }],
  })));

  const { result } = renderHook(() => useLiveIndices(), { wrapper: queryWrapper });
  await waitFor(() => expect(result.current.data?.[0]).toEqual({
    kind: 'index',
    id: 'KOSPI',
    label: 'KOSPI',
    investorScope: 'market',
  }));
});
```

Adapt imports to the existing test server helpers used by nearby API tests.

- [ ] **Step 2: Run RED**

Run: `cd frontend && npx vitest run src/api/liveIndices.test.tsx`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement hooks**

Create hooks using existing API client/query conventions from `livePastCandles.tsx` and `livePastDailyCandles.tsx`. Use query keys prefixed with `['live-indices']`, `['live-index-candles']`, and `['live-index-investor-net']`.

- [ ] **Step 4: Write failing search/deep-link tests**

Extend `LiveSymbolSearch.test.tsx`:

```tsx
it('selecting an index result opens an index instrument tab', async () => {
  render(<LiveSymbolSearch />);
  await userEvent.type(screen.getByRole('combobox'), 'kospi');
  await userEvent.click(await screen.findByText('KOSPI'));
  expect(useLiveTabsStore.getState().tabs[0].instrument).toEqual({
    kind: 'index',
    id: 'KOSPI',
    label: 'KOSPI',
  });
});
```

Extend `LivePage.test.tsx`:

```tsx
it('reads active index from ?index= deep link without setting activeCode', async () => {
  renderLivePage('/live?index=KOSPI');
  expect(useLivePageStore.getState().activeInstrument).toEqual({
    kind: 'index',
    id: 'KOSPI',
    label: 'KOSPI',
  });
  expect(useLivePageStore.getState().activeCode).toBeNull();
});
```

- [ ] **Step 5: Run RED**

Run: `cd frontend && npx vitest run src/live/LiveSymbolSearch.test.tsx src/live/LivePage.test.tsx`

Expected: FAIL because index rows and `?index` are not handled.

- [ ] **Step 6: Implement search and deep links**

Merge index entries from `useLiveIndices()` with stock search rows when query matches id or label. Render an index badge labeled `지수` and omit `WatchlistHeartButton` for index rows. In `LivePage`, seed `?index=` through `setActiveTabInstrument(indexInstrument(id, label))`; keep `?code=` stock behavior.

- [ ] **Step 7: Run GREEN**

Run: `cd frontend && npx vitest run src/api/liveIndices.test.tsx src/live/LiveSymbolSearch.test.tsx src/live/LivePage.test.tsx`

Expected: PASS.

---

### Task 5: LivePage Session Split, Indicator Capabilities, and Drawing Subject Keys

**Files:**
- Create: `frontend/src/live/liveInstrumentCapabilities.ts`
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/LiveWorkarea.tsx`
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/paneSpecsForTimeframe.ts`
- Modify: `frontend/src/live/paneSpecsForTimeframe.test.ts`
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Modify: `frontend/src/live/indicators/IndicatorPanel.test.tsx`
- Modify: `frontend/src/chart/useDrawingHost.ts`
- Modify: `frontend/src/state/drawings.ts`
- Modify: `frontend/src/state/drawings.test.ts`
- Modify: `frontend/src/studyViews/LiveStudyViewSaveButton.tsx`
- Modify: `frontend/src/live/LiveToolbar.test.tsx`

**Interfaces:**
- Produces:
  - `capabilitiesForInstrument(instrument)`
  - `hogaPanes: boolean`
  - `investorNet: 'none' | 'stock' | 'market' | 'index'`
  - `studySave: boolean`
  - `drawingSubjectKey`

- [ ] **Step 1: Write failing capability tests**

Create `frontend/src/live/liveInstrumentCapabilities.test.ts`:

```ts
it('disables hoga panes and study save for indices while allowing market investor panes on KOSPI', () => {
  expect(capabilitiesForInstrument({ kind: 'index', id: 'KOSPI', label: 'KOSPI' })).toMatchObject({
    hogaPanes: false,
    investorNet: 'market',
    studySave: false,
  });
});

it('keeps stock capabilities unchanged', () => {
  expect(capabilitiesForInstrument({ kind: 'stock', code: '005930', label: '삼성전자' })).toMatchObject({
    hogaPanes: true,
    investorNet: 'stock',
    studySave: true,
  });
});
```

- [ ] **Step 2: Run RED**

Run: `cd frontend && npx vitest run src/live/liveInstrumentCapabilities.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement capabilities**

Create the capability helper and thread it through `LivePage`, `LiveWorkarea`, `IndicatorPanel`, and `paneSpecsForTimeframe`.

- [ ] **Step 4: Write failing no-stock-hook session tests**

Extend `LivePage.test.tsx` to mock `useLiveSeries` and assert it receives no index id / does not subscribe when active instrument is index. Prefer session component split:

```tsx
it('index mode does not subscribe to stock live series', async () => {
  renderLivePage('/live?index=KOSPI');
  expect(useLiveSeriesSpy).not.toHaveBeenCalledWith('KOSPI');
});
```

- [ ] **Step 5: Run RED**

Run: `cd frontend && npx vitest run src/live/LivePage.test.tsx`

Expected: FAIL because current `LivePage` always calls stock live data hooks.

- [ ] **Step 6: Split sessions**

Refactor `LivePage` so top-level shell computes active instrument and renders:

```tsx
{activeInstrument?.kind === 'stock' ? (
  <LiveStockSession instrument={activeInstrument} />
) : activeInstrument?.kind === 'index' ? (
  <LiveIndexSession instrument={activeInstrument} />
) : (
  <LiveEmptyState variant="no_active_code" />
)}
```

Keep stock hooks inside `LiveStockSession`. Use index candle/investor hooks inside `LiveIndexSession`. Disable study-save source for index sessions.

- [ ] **Step 7: Add indicator and pane tests**

Extend `IndicatorPanel.test.tsx` to render with index capabilities and assert 호가 지표 rows are absent while MA/volume/investor rows remain. Extend `paneSpecsForTimeframe.test.ts` to assert hoga pane specs are absent for index capabilities and market investor panes appear only on `D`.

- [ ] **Step 8: Add drawing subject tests**

Update `drawings.test.ts`:

```ts
it('stores stock and index drawings under separate subject keys', () => {
  useDrawingsStore.getState().add('stock:005930', makeHLine());
  useDrawingsStore.getState().add('index:KOSPI', makeHLine());
  expect(useDrawingsStore.getState().bySubject.get('stock:005930')).toHaveLength(1);
  expect(useDrawingsStore.getState().bySubject.get('index:KOSPI')).toHaveLength(1);
});
```

- [ ] **Step 9: Run GREEN**

Run:

```bash
cd frontend
npx vitest run \
  src/live/liveInstrumentCapabilities.test.ts \
  src/live/LivePage.test.tsx \
  src/live/paneSpecsForTimeframe.test.ts \
  src/live/indicators/IndicatorPanel.test.tsx \
  src/state/drawings.test.ts \
  src/live/LiveToolbar.test.tsx
```

Expected: PASS.

---

### Task 6: End-to-End Verification and Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-06-22-live-index-instruments-design.md`
- Modify: `CONTEXT.md`
- Create: `docs/adr/00xx-live-instrument-active-view.md` or the next ADR number used by this repo

**Interfaces:**
- Consumes: all prior tasks.
- Produces: checked implementation contract and ADR.

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
uv run pytest \
  tests/unit/live/test_index_registry.py \
  tests/unit/live/test_kis_index_parsers.py \
  tests/api/test_live_indices_routes.py
```

Expected: PASS.

- [ ] **Step 2: Run focused frontend tests**

Run:

```bash
cd frontend
npx vitest run \
  src/state/liveTabs.test.ts \
  src/state/livePage.test.ts \
  src/api/liveIndices.test.tsx \
  src/live/LiveSymbolSearch.test.tsx \
  src/live/LivePage.test.tsx \
  src/live/liveInstrumentCapabilities.test.ts \
  src/live/paneSpecsForTimeframe.test.ts \
  src/live/indicators/IndicatorPanel.test.tsx \
  src/state/drawings.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run type/build checks**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual smoke with dev server**

Run backend/frontend as the repo normally does, open `/live`, and verify:

- `/live?code=005930` opens stock path and stock hoga indicators remain available.
- `/live?index=KOSPI` opens KOSPI chart, no orderbook-derived indicators are visible.
- Search for `kospi` shows index entries with `지수` badge and no heart button.
- KOSPI/KOSDAQ daily chart can show market investor panes when KIS data is available.
- KOSPI200/KOSDAQ150/KRX100/KRX300 do not show investor panes unless direct support exists.
- Switching stock → index → stock does not leave stale hoga panes or stale stock SSE data.

- [ ] **Step 5: Update docs and ADR**

Record:

- `activeInstrument` is `/live` canonical active subject.
- `activeCode` is stock-only compatibility projection.
- Representative indices are not Watchlist/Live Set members.
- Index investor panes distinguish market-level data from stock-level data.
- Study view save is stock-only for this release.

- [ ] **Step 6: Final verification**

Run `git diff --check`, focused tests above, and `git status --short`. Include any skipped checks in the final response.

