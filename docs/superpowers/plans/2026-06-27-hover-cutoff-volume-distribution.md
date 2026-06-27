# Hover-Cutoff Volume Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `호버 시점 누적 매물대` mode where `/live` and v2 `/study` volume-distribution bars use only continuous trades up to the hovered candle time.

**Architecture:** Extend the existing `/api/range?mode=sidecar` read path with a single-date `volume_distribution_cutoff_ms` parameter. Keep the normal range bundle as the final-profile baseline, then add one shared frontend hook that selects either the final profile or a cursor-specific cutoff profile for both `/live` and v2 `/study`.

**Tech Stack:** FastAPI + Pydantic + DuckDB/Parquet backend; React + Zustand + TanStack Query + Vitest frontend.

## Global Constraints

- Canonical term: `호버 시점 누적 매물대 (Hover-Cutoff Volume Distribution)`.
- Parent indicator remains `연속체결 매물대 분포`.
- Default behavior and default setting must remain final full-Stock-Date distribution.
- New setting name: `volumeDistributionHoverCutoffEnabled`, default `false`.
- The price grid is always the selected Stock-Date candle low-high range; only counted trade quantity is cutoff.
- Cutoff is inclusive: count trades with decoded trade time `<= volume_distribution_cutoff_ms`.
- Cutoff range requests are valid only when `from == to`.
- Legacy `스냅샷 학습뷰` is out of scope and must not issue cutoff sidecar requests.
- Do not create a new endpoint; reuse `/api/range` and `mode=sidecar`.
- Do not merge cutoff profiles into the main range bundle.

---

## File Structure

- Modify `hoga/tables/trades.py`: add an optional `upper_bound_ms` argument to `query_continuous_trade_volume_distribution`.
- Modify `hoga/api/bundle.py`: thread `volume_distribution_cutoff_ms` through `build_range_bundle` and `build_volume_distribution_slice`.
- Modify `hoga/api/routes.py`: validate and forward `volume_distribution_cutoff_ms`.
- Modify backend tests under `tests/unit/api/`: add route/bundle coverage for cutoff semantics and multi-day rejection.
- Modify `frontend/src/api/rangeRequest.ts`: add `volumeDistributionCutoffMs` to options, query key, URL, and placeholder compatibility.
- Modify `frontend/src/api/range.test.tsx`: cover URL/key behavior.
- Modify `frontend/src/state/liveIndicatorsPersistence.ts` and `frontend/src/state/livePage.ts`: persist `volumeDistributionHoverCutoffEnabled`.
- Modify `frontend/src/live/indicators/IndicatorPanel.tsx`: add the settings toggle.
- Modify frontend state/settings tests.
- Modify `frontend/src/live/continuousTradeVolumeDistribution.ts`: export pure tail merge / cutoff fallback helpers.
- Create `frontend/src/live/useVolumeDistributionCutoffProfile.ts`: shared hook for `/live` and v2 `/study`.
- Modify `frontend/src/live/LiveSidebar.tsx`: consume the shared hook.
- Modify `frontend/src/studyViews/StudyReferenceDetailPanel.tsx`: consume the shared hook for v2 복기뷰.
- Modify frontend tests for helper/hook/live/study behavior.

---

### Task 1: Backend Cutoff Query

**Files:**
- Modify: `hoga/tables/trades.py`
- Modify: `hoga/api/bundle.py`
- Test: `tests/unit/api/test_range_volume_distribution_cutoff.py`

**Interfaces:**
- Produces: `query_continuous_trade_volume_distribution(con, *, path, price_lo, price_hi, bins, session_open_ms, session_close_ms, upper_bound_ms=None) -> VolumeProfileBinning`
- Produces: `build_volume_distribution_slice(engine, *, code, date, source, session_open_ms, session_close_ms, range_count, price_min=None, price_max=None, cutoff_ms=None) -> DayVolumeDistribution | None`
- Consumes: existing `VolumeProfileBinning`, `_session_bound_to_intra_ms`, `hhmmssms_to_unix_ms`, `ms_from_midnight_to_unix_ms`

- [ ] **Step 1: Write backend cutoff unit/API tests**

Create `tests/unit/api/test_range_volume_distribution_cutoff.py` with this test scaffold:

```python
from __future__ import annotations

from pathlib import Path

import polars as pl
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.routes import build_router
from hoga.api.models import RangeBundle
from hoga.api.queries import QueryEngine
from hoga.api.timeenc import ms_from_midnight_to_unix_ms


def _write_stock_date(root: Path) -> None:
    code_dir = root / "parquet" / "20260625" / "005930" / "hogaplay"
    code_dir.mkdir(parents=True)
    (code_dir / "meta.json").write_text(
        """
        {
          "code": "005930",
          "name": "삼성전자",
          "regular_session_open_ms": 90000000,
          "regular_session_close_ms": 153000000,
          "prev_close": 100,
          "upper_limit": 130,
          "lower_limit": 70,
          "today_open": 100,
          "today_high": 120,
          "today_low": 100,
          "today_close": 115,
          "pages_collected": 1,
          "total_unique_events": 1,
          "parser_version": "test"
        }
        """,
        encoding="utf-8",
    )
    pl.DataFrame(
        [
            {"ts_ms": 90_000_000, "open": 100, "high": 120, "low": 100, "close": 110, "vol_a": 0, "vol_b": 0},
        ],
    ).write_parquet(code_dir / "candles.parquet")
    pl.DataFrame(
        [
            {"ts_ms": 90_000_000, "seq": 1, "price": 100, "change_pct": 0.0, "qty": 10, "side": 1, "cum_vol": 10, "cum_trades": 1, "low_so_far": 100, "high_so_far": 100, "net_pressure": 10},
            {"ts_ms": 90_001_000, "seq": 2, "price": 110, "change_pct": 0.0, "qty": 20, "side": -1, "cum_vol": 30, "cum_trades": 2, "low_so_far": 100, "high_so_far": 110, "net_pressure": -10},
            {"ts_ms": 90_001_000, "seq": 3, "price": 120, "change_pct": 0.0, "qty": 999, "side": 0, "cum_vol": 0, "cum_trades": 3, "low_so_far": 100, "high_so_far": 120, "net_pressure": 0},
            {"ts_ms": 90_002_000, "seq": 4, "price": 120, "change_pct": 0.0, "qty": 30, "side": 1, "cum_vol": 60, "cum_trades": 4, "low_so_far": 100, "high_so_far": 120, "net_pressure": 20},
        ],
    ).write_parquet(code_dir / "trades.parquet")


def _client(tmp_path: Path) -> TestClient:
    _write_stock_date(tmp_path)
    engine = QueryEngine(tmp_path)
    app = FastAPI()
    app.include_router(build_router(engine=engine))
    return TestClient(app)
```

Then add tests with these expected assertions:

```python
def test_volume_distribution_cutoff_includes_exact_cutoff_and_excludes_later(tmp_path: Path) -> None:
    client = _client(tmp_path)
    cutoff_ms = ms_from_midnight_to_unix_ms("20260625", 90_001_000)
    resp = client.get(
        "/api/range",
        params={
            "code": "005930",
            "from": "20260625",
            "to": "20260625",
            "bucket_ms": 60_000,
            "mode": "sidecar",
            "source_pref": "hogaplay",
            "volume_distribution_bins": 2,
            "volume_distribution_cutoff_ms": cutoff_ms,
        },
    )
    assert resp.status_code == 200
    bundle = RangeBundle.model_validate(resp.json())
    profile = bundle.volume_distributions[0]
    assert [b.qty for b in profile.bins] == [10, 20]
    assert profile.last_trade_ms == cutoff_ms


def test_volume_distribution_without_cutoff_preserves_final_profile(tmp_path: Path) -> None:
    client = _client(tmp_path)
    resp = client.get(
        "/api/range",
        params={
            "code": "005930",
            "from": "20260625",
            "to": "20260625",
            "bucket_ms": 60_000,
            "mode": "sidecar",
            "source_pref": "hogaplay",
            "volume_distribution_bins": 2,
        },
    )
    assert resp.status_code == 200
    bundle = RangeBundle.model_validate(resp.json())
    assert [b.qty for b in bundle.volume_distributions[0].bins] == [10, 50]
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/api/test_range_volume_distribution_cutoff.py -q
```

Expected: FAIL because `volume_distribution_cutoff_ms` is not accepted and cutoff logic is not implemented.

- [ ] **Step 3: Add optional upper bound to the DuckDB query**

In `hoga/tables/trades.py`, change the function signature and effective upper bound:

```python
def query_continuous_trade_volume_distribution(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    price_lo: int,
    price_hi: int,
    bins: int,
    session_open_ms: int,
    session_close_ms: int,
    upper_bound_ms: int | None = None,
) -> VolumeProfileBinning:
    bin_width = (price_hi - price_lo) / bins
    if bin_width <= 0:
        bin_width = 1
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    session_open_intra_ms = _session_bound_to_intra_ms(session_open_ms)
    session_close_intra_ms = _session_bound_to_intra_ms(session_close_ms)
    effective_upper_intra_ms = (
        min(session_close_intra_ms, upper_bound_ms)
        if upper_bound_ms is not None
        else session_close_intra_ms
    )
```

Then pass `effective_upper_intra_ms` instead of `session_close_intra_ms` to the query parameter list:

```python
[str(path), session_open_intra_ms, effective_upper_intra_ms],
```

- [ ] **Step 4: Thread cutoff through bundle building**

In `hoga/api/bundle.py`, add `cutoff_ms: int | None = None` to `build_volume_distribution_slice`.

Inside it, compute the inclusive upper bound using `unix_ms_to_hhmmssms` plus the existing table-local `_session_bound_to_intra_ms` convention:

```python
from hoga.api.timeenc import unix_ms_to_hhmmssms

upper_bound_ms = None
if cutoff_ms is not None:
    cutoff_hhmmssms = unix_ms_to_hhmmssms(date, cutoff_ms)
    upper_bound_ms = trades_tbl._session_bound_to_intra_ms(cutoff_hhmmssms) + 1
```

Pass `upper_bound_ms=upper_bound_ms` to `query_continuous_trade_volume_distribution`.

- [ ] **Step 5: Run backend tests**

Run:

```bash
uv run pytest tests/unit/api/test_range_volume_distribution_cutoff.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/tables/trades.py hoga/api/bundle.py tests/unit/api/test_range_volume_distribution_cutoff.py
git commit -m "feat: support cutoff volume distribution query"
```

---

### Task 2: Range API Parameter Validation

**Files:**
- Modify: `hoga/api/routes.py`
- Modify: `hoga/api/bundle.py`
- Test: `tests/unit/api/test_range_volume_distribution_cutoff.py`

**Interfaces:**
- Consumes: `build_range_bundle(engine, *, code, from_date, to_date, bucket_ms, source_pref, broker_late_entries_enabled, broker_late_entry_start_hhmm, volume_distribution_bins, trade_volume_poc_bins, volume_distribution_price_min, volume_distribution_price_max, volume_distribution_cutoff_ms, mode) -> RangeBundle`
- Produces: `/api/range?code=005930&from=20260625&to=20260625&bucket_ms=60000&mode=sidecar&volume_distribution_bins=10&volume_distribution_cutoff_ms=1782403201000`

- [ ] **Step 1: Add failing API validation tests**

Append:

```python
def test_volume_distribution_cutoff_requires_single_stock_date(tmp_path: Path) -> None:
    client = _client(tmp_path)
    cutoff_ms = ms_from_midnight_to_unix_ms("20260625", 90_001_000)
    resp = client.get(
        "/api/range",
        params={
            "code": "005930",
            "from": "20260624",
            "to": "20260625",
            "bucket_ms": 60_000,
            "mode": "sidecar",
            "source_pref": "hogaplay",
            "volume_distribution_bins": 2,
            "volume_distribution_cutoff_ms": cutoff_ms,
        },
    )
    assert resp.status_code == 400
    assert "single Stock-Date" in resp.text
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/unit/api/test_range_volume_distribution_cutoff.py::test_volume_distribution_cutoff_requires_single_stock_date -q
```

Expected: FAIL because the parameter is not validated yet.

- [ ] **Step 3: Implement route parameter**

In `hoga/api/routes.py`, add:

```python
volume_distribution_cutoff_ms: int | None = Query(None, ge=0),
```

Then after the existing volume distribution price validation, add:

```python
if volume_distribution_cutoff_ms is not None and from_date != to_date:
    raise HTTPException(400, "volume_distribution_cutoff_ms requires a single Stock-Date range")
```

Pass it into `build_range_bundle`.

In `hoga/api/bundle.py`, add the parameter to `build_range_bundle` and pass it to `build_volume_distribution_slice`:

```python
volume_distribution_cutoff_ms=volume_distribution_cutoff_ms,
```

- [ ] **Step 4: Run route tests**

Run:

```bash
uv run pytest tests/unit/api/test_range_volume_distribution_cutoff.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/routes.py hoga/api/bundle.py tests/unit/api/test_range_volume_distribution_cutoff.py
git commit -m "feat: validate volume distribution cutoff parameter"
```

---

### Task 3: Frontend Range Request Contract

**Files:**
- Modify: `frontend/src/api/rangeRequest.ts`
- Modify: `frontend/src/api/range.test.tsx`

**Interfaces:**
- Produces: `RangeRequestOptions.volumeDistributionCutoffMs?: number | null`
- Produces: `volume_distribution_cutoff_ms` in query string
- Produces: cutoff value in `RangeQueryKey`

- [ ] **Step 1: Write failing frontend request tests**

In `frontend/src/api/range.test.tsx`, add:

```ts
it('threads volume_distribution_cutoff_ms into query string', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
  renderHook(() => useRange('005930', '20260625', '20260625', '1m', undefined, null, {
    mode: 'sidecar',
    volumeDistributionBins: 10,
    volumeDistributionCutoffMs: 1_772_000_001_000,
  }), { wrapper: makeWrapper() });
  await waitFor(() => expect(spy).toHaveBeenCalled());
  expect(spy.mock.calls[0][0]).toContain('&volume_distribution_cutoff_ms=1772000001000');
});

it('includes volumeDistributionCutoffMs in the range query key', () => {
  const req = buildRangeBundleRequest({
    code: '005930',
    from: '20260625',
    to: '20260625',
    timeframe: '1m',
    sourcePref: 'hogaplay',
    options: {
      mode: 'sidecar',
      volumeDistributionBins: 10,
      volumeDistributionCutoffMs: 1_772_000_001_000,
    },
  });
  expect(req.queryKey).toContain(1_772_000_001_000);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/api/range.test.tsx
```

Expected: FAIL because `volumeDistributionCutoffMs` is not in the type/key/url.

- [ ] **Step 3: Implement request option**

In `frontend/src/api/rangeRequest.ts`, add:

```ts
volumeDistributionCutoffMs?: number | null;
```

Extend `RangeQueryKey` with a final `number | null` entry. Add this value after `mode` so older indices remain easier to audit:

```ts
RangeMode | null,
number | null,
```

In `buildRangeBundleRequest`:

```ts
const volumeDistributionCutoffMs = options.volumeDistributionCutoffMs ?? null;
const queryKey: RangeQueryKey = [
  'range',
  input.code,
  input.from,
  input.to,
  bucketMs,
  input.priceRange?.min,
  input.priceRange?.max,
  brokerLateEntriesEnabled,
  brokerLateEntryStartHHMM,
  volumeDistributionBins,
  volumeDistributionPriceRange?.min,
  volumeDistributionPriceRange?.max,
  tradeVolumePocBins,
  input.sourcePref,
mode,
volumeDistributionCutoffMs,
];
```

Add URL param:

```ts
addParam(params, 'volume_distribution_cutoff_ms', volumeDistributionCutoffMs);
```

Update `PLACEHOLDER_COMPATIBLE_KEY_INDICES` so cutoff changes do not reuse incompatible placeholder data as if it were the same profile. Exclude the new cutoff key from compatibility for cutoff-specific sidecars.

- [ ] **Step 4: Run frontend request tests**

Run:

```bash
cd frontend && npx vitest run src/api/range.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/rangeRequest.ts frontend/src/api/range.test.tsx
git commit -m "feat: thread volume distribution cutoff in range requests"
```

---

### Task 4: Persisted Indicator Toggle

**Files:**
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/state/livePage.ts`
- Modify: `frontend/src/state/liveIndicatorsPersistence.test.ts`
- Modify: `frontend/src/state/livePage.test.ts`
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Modify: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

**Interfaces:**
- Produces: `volumeDistributionHoverCutoffEnabled: boolean`
- Produces: `setVolumeDistributionHoverCutoffEnabled(enabled: boolean): void`

- [ ] **Step 1: Write failing persistence tests**

In `frontend/src/state/liveIndicatorsPersistence.test.ts`, add:

```ts
it('defaults hover cutoff volume distribution mode to false and preserves persisted values', () => {
  const defaults = mergeLiveIndicatorPrefs({});
  expect(defaults.volumeDistributionHoverCutoffEnabled).toBe(false);

  expect(mergeLiveIndicatorPrefs({ volumeDistributionHoverCutoffEnabled: true }).volumeDistributionHoverCutoffEnabled).toBe(true);
  expect(mergeLiveIndicatorPrefs({ volumeDistributionHoverCutoffEnabled: false }).volumeDistributionHoverCutoffEnabled).toBe(false);
});
```

In `frontend/src/state/livePage.test.ts`, extend the indicator persistence test:

```ts
useLivePageStore.getState().setVolumeDistributionHoverCutoffEnabled(true);
const persisted = JSON.parse(localStorage.getItem('live.indicators.v1')!);
expect(persisted.volumeDistributionHoverCutoffEnabled).toBe(true);
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts src/state/livePage.test.ts
```

Expected: FAIL because the field and setter do not exist.

- [ ] **Step 3: Add state field and setter**

In `PersistedIndicators`, add:

```ts
volumeDistributionHoverCutoffEnabled: boolean;
```

In `mergeLiveIndicatorPrefs`, set:

```ts
const volumeDistributionHoverCutoffEnabled = obj?.volumeDistributionHoverCutoffEnabled === true;
```

Include it in the returned object.

In `frontend/src/state/livePage.ts`, add store method:

```ts
setVolumeDistributionHoverCutoffEnabled: (enabled: boolean) => void;
```

Include field in `snapshotIndicators`:

```ts
volumeDistributionHoverCutoffEnabled: s.volumeDistributionHoverCutoffEnabled,
```

Implement setter:

```ts
setVolumeDistributionHoverCutoffEnabled: (enabled) => {
  set({ volumeDistributionHoverCutoffEnabled: enabled });
  persistIndicators(snapshotIndicators(get));
},
```

- [ ] **Step 4: Add UI toggle**

In the `volume-distribution` settings section of `IndicatorPanel.tsx`, add a checkbox/toggle row:

```tsx
<label className="flex items-center justify-between gap-3 rounded border border-border-subtle bg-bg-input px-3 py-2 text-xs text-fg">
  <span>호버 시점 누적</span>
  <input
    type="checkbox"
    checked={volumeDistributionHoverCutoffEnabled}
    onChange={(event) => setVolumeDistributionHoverCutoffEnabled(event.currentTarget.checked)}
  />
</label>
```

Use the existing toggle control style if the file already has one for adjacent binary settings.

- [ ] **Step 5: Add panel test**

In `IndicatorPanel.test.tsx`, add:

```ts
it('toggles hover-cutoff mode for volume distribution', () => {
  useLivePageStore.setState({ volumeDistributionHoverCutoffEnabled: false });
  render(<IndicatorPanel />);
  fireEvent.click(screen.getByText('연속체결 매물대 분포'));
  fireEvent.click(screen.getByRole('checkbox', { name: '호버 시점 누적' }));
  expect(useLivePageStore.getState().volumeDistributionHoverCutoffEnabled).toBe(true);
});
```

- [ ] **Step 6: Run tests**

Run:

```bash
cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts src/state/livePage.test.ts src/live/indicators/IndicatorPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/livePage.ts frontend/src/state/liveIndicatorsPersistence.test.ts frontend/src/state/livePage.test.ts frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx
git commit -m "feat: add hover cutoff volume distribution setting"
```

---

### Task 5: Pure Distribution Cutoff Helpers

**Files:**
- Modify: `frontend/src/live/continuousTradeVolumeDistribution.ts`
- Modify: `frontend/src/live/continuousTradeVolumeDistribution.test.ts`

**Interfaces:**
- Produces: `mergeVolumeDistributionTail(profile, trades, cursorMs) -> DayVolumeDistribution`
- Produces: `computeContinuousTradeVolumeDistribution({ date, candles, trades, rangeCount, segment, cutoffMs }) -> DayVolumeDistribution | null`

- [ ] **Step 1: Write failing helper tests**

In `continuousTradeVolumeDistribution.test.ts`, add:

```ts
it('merges only continuous live tail trades after last_trade_ms and at or before cursor', () => {
  const selected = mergeVolumeDistributionTail(profile({ last_trade_ms: 90_001_000 }), [
    { t_ms: 90_000_000, price: 105, qty: 999, side: 1 },
    { t_ms: 90_002_000, price: 105, qty: 7, side: 1 },
    { t_ms: 90_003_000, price: 115, qty: 11, side: -1 },
    { t_ms: 90_004_000, price: 115, qty: 999, side: 1 },
    { t_ms: 90_002_000, price: 115, qty: 999, side: 0 },
  ], 90_003_000);

  expect(selected.bins.map((bin) => bin.qty)).toEqual([17, 31]);
  expect(selected.last_trade_ms).toBe(90_003_000);
});

it('computes a live fallback distribution only up to cutoffMs', () => {
  const selected = computeContinuousTradeVolumeDistribution({
    date: '20260625',
    candles: [{ ts_ms: 1, open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
    trades: [
      { t_ms: 90_000_000, price: 100, qty: 10, side: 1 },
      { t_ms: 90_001_000, price: 110, qty: 20, side: -1 },
      { t_ms: 90_002_000, price: 120, qty: 30, side: 1 },
    ],
    rangeCount: 2,
    segment: { date: '20260625', session_open_ms: 90_000_000, session_close_ms: 153_000_000 },
    cutoffMs: 90_001_000,
  });

  expect(selected?.bins.map((bin) => bin.qty)).toEqual([10, 20]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/live/continuousTradeVolumeDistribution.test.ts
```

Expected: FAIL because `mergeVolumeDistributionTail` and `cutoffMs` are missing.

- [ ] **Step 3: Export tail merge helper**

Rename internal `mergeVolumeDistributionDelta` to exported `mergeVolumeDistributionTail` and add cursor filtering:

```ts
export function mergeVolumeDistributionTail(
  profile: DayVolumeDistribution,
  trades: readonly ContinuousTradeLike[],
  cursorMs: number | null,
): DayVolumeDistribution {
  if (cursorMs == null || profile.last_trade_ms == null || profile.bins.length === 0) return profile;
  const rangeCount = profile.bins.length;
  const rawBinWidth = (profile.price_max - profile.price_min) / rangeCount;
  const binWidth = rawBinWidth > 0 ? rawBinWidth : 1;
  const bins = profile.bins.map((bin) => ({ ...bin }));
  let lastTradeMs = profile.last_trade_ms;
  for (const trade of trades) {
    if (trade.t_ms <= profile.last_trade_ms) continue;
    if (trade.t_ms > cursorMs) continue;
    if (trade.t_ms < profile.session_open_ms || trade.t_ms >= profile.session_close_ms) continue;
    if (trade.side !== 1 && trade.side !== -1) continue;
    if (!Number.isFinite(trade.price) || trade.price <= 0) continue;
    if (!Number.isFinite(trade.qty) || trade.qty <= 0) continue;
    if (trade.price < profile.price_min || trade.price > profile.price_max) continue;
    const idx = Math.max(0, Math.min(rangeCount - 1, Math.floor((trade.price - profile.price_min) / binWidth)));
    bins[idx] = { ...bins[idx], qty: bins[idx].qty + trade.qty };
    lastTradeMs = Math.max(lastTradeMs, trade.t_ms);
  }
  return lastTradeMs === profile.last_trade_ms ? profile : { ...profile, bins, last_trade_ms: lastTradeMs };
}
```

Update existing `selectVolumeDistributionProfile` to call `mergeVolumeDistributionTail(persistedProfile, args.liveTrades, null)` only if needed for the final profile path, or keep a separate final-merge helper if that preserves current behavior more clearly.

- [ ] **Step 4: Add `cutoffMs` to live fallback compute**

Extend `computeContinuousTradeVolumeDistribution` args:

```ts
cutoffMs?: number | null;
```

Inside the trade loop:

```ts
if (cutoffMs != null && trade.t_ms > cutoffMs) continue;
```

- [ ] **Step 5: Run helper tests**

Run:

```bash
cd frontend && npx vitest run src/live/continuousTradeVolumeDistribution.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/continuousTradeVolumeDistribution.ts frontend/src/live/continuousTradeVolumeDistribution.test.ts
git commit -m "feat: add cutoff volume distribution helpers"
```

---

### Task 6: Shared Cutoff Profile Hook

**Files:**
- Create: `frontend/src/live/useVolumeDistributionCutoffProfile.ts`
- Create: `frontend/src/live/useVolumeDistributionCutoffProfile.test.tsx`

**Interfaces:**
- Produces:

```ts
export function useVolumeDistributionCutoffProfile(args: {
  enabled: boolean;
  code: string | null;
  timeframe: Timeframe | null;
  date: string | null;
  cursorMs: number | null;
  todayKst: string | null;
  rangeCount: number;
  sourcePref: SourcePreference;
  finalProfile: DayVolumeDistribution | null | undefined;
  priceRange: { min: number; max: number } | null;
  liveTrades?: readonly ContinuousTradeLike[];
  candles?: readonly Candle[];
  segment?: RangeSegment | null;
}): DayVolumeDistribution | null | undefined;
```

- [ ] **Step 1: Write failing hook tests**

Create `useVolumeDistributionCutoffProfile.test.tsx` with mocked `useRange`:

```ts
vi.mock('../api/range', async () => {
  const actual = await vi.importActual<typeof import('../api/range')>('../api/range');
  return {
    ...actual,
    useRange: vi.fn(),
  };
});
```

Add tests:

```ts
import type { DayVolumeDistribution, RangeBundle } from '../api/types';

const profile = (overrides: Partial<DayVolumeDistribution> = {}): DayVolumeDistribution => ({
  date: '20260625',
  range_count: 2,
  price_min: 100,
  price_max: 120,
  session_open_ms: 90_000_000,
  session_close_ms: 153_000_000,
  last_trade_ms: 90_001_000,
  bins: [
    { price_low: 100, price_high: 110, qty: 10 },
    { price_low: 110, price_high: 120, qty: 20 },
  ],
  ...overrides,
});

const emptyBundle: RangeBundle = {
  code: '005930',
  from_date: '20260625',
  to_date: '20260625',
  bucket_ms: 60_000,
  segments: [],
  candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

it('returns final profile when hover cutoff is disabled', () => {
  mockedUseRange.mockReturnValue({ data: undefined, isLoading: false });
  const finalProfile = profile();
  const { result } = renderHook(() => useVolumeDistributionCutoffProfile({
    enabled: false,
    code: '005930',
    timeframe: '1m',
    date: '20260625',
    cursorMs: 90_001_000,
    todayKst: null,
    rangeCount: 2,
    sourcePref: 'hogaplay',
    finalProfile,
    priceRange: null,
  }));
  expect(result.current).toBe(finalProfile);
});

it('requests a single-date sidecar and returns the cutoff profile', () => {
  const cutoffProfile = profile({ bins: [{ price_low: 100, price_high: 110, qty: 7 }, { price_low: 110, price_high: 120, qty: 0 }] });
  mockedUseRange.mockReturnValue({ data: { ...emptyBundle, volume_distributions: [cutoffProfile] }, isLoading: false });
  const { result } = renderHook(() => useVolumeDistributionCutoffProfile({
    enabled: true,
    code: '005930',
    timeframe: '1m',
    date: '20260625',
    cursorMs: 90_001_000,
    todayKst: null,
    rangeCount: 2,
    sourcePref: 'hogaplay',
    finalProfile: profile(),
    priceRange: null,
  }));
  expect(mockedUseRange).toHaveBeenCalledWith('005930', '20260625', '20260625', '1m', undefined, null, {
    mode: 'sidecar',
    volumeDistributionBins: 2,
    volumeDistributionCutoffMs: 90_001_000,
    volumeDistributionPriceRange: null,
  });
  expect(result.current).toBe(cutoffProfile);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/live/useVolumeDistributionCutoffProfile.test.tsx
```

Expected: FAIL because hook file does not exist.

- [ ] **Step 3: Implement shared hook**

Create `frontend/src/live/useVolumeDistributionCutoffProfile.ts`:

```ts
import { useMemo } from 'react';
import { useRange } from '../api/range';
import type { Candle, DayVolumeDistribution, RangeSegment, Timeframe } from '../api/types';
import type { SourcePreference } from '../state/sourcePreference';
import {
  computeContinuousTradeVolumeDistribution,
  mergeVolumeDistributionTail,
} from './continuousTradeVolumeDistribution';

type ContinuousTradeLike = {
  t_ms: number;
  price: number;
  qty: number;
  side: number;
};

export function useVolumeDistributionCutoffProfile(args: {
  enabled: boolean;
  code: string | null;
  timeframe: Timeframe | null;
  date: string | null;
  cursorMs: number | null;
  todayKst: string | null;
  rangeCount: number;
  sourcePref: SourcePreference;
  finalProfile: DayVolumeDistribution | null | undefined;
  priceRange: { min: number; max: number } | null;
  liveTrades?: readonly ContinuousTradeLike[];
  candles?: readonly Candle[];
  segment?: RangeSegment | null;
}): DayVolumeDistribution | null | undefined {
  const queryEnabled = args.enabled && !!(args.code && args.timeframe && args.date && args.cursorMs != null);
  const query = useRange(
    queryEnabled ? args.code : null,
    queryEnabled ? args.date : null,
    queryEnabled ? args.date : null,
    queryEnabled ? args.timeframe : null,
    undefined,
    args.todayKst,
    {
      mode: 'sidecar',
      volumeDistributionBins: args.rangeCount,
      volumeDistributionCutoffMs: queryEnabled ? args.cursorMs : null,
      volumeDistributionPriceRange: args.priceRange,
    },
  );

  return useMemo(() => {
    if (!args.enabled || !queryEnabled) return args.finalProfile;
    const sidecarProfile = query.data?.volume_distributions.find((profile) => profile.date === args.date) ?? null;
    const liveTrades = args.liveTrades ?? [];
    if (sidecarProfile) {
      return mergeVolumeDistributionTail(sidecarProfile, liveTrades, args.cursorMs);
    }
    if (args.date === args.todayKst && args.segment && args.candles && liveTrades.length > 0 && args.cursorMs != null) {
      return computeContinuousTradeVolumeDistribution({
        date: args.date,
        candles: args.candles,
        trades: liveTrades,
        rangeCount: args.rangeCount,
        segment: args.segment,
        cutoffMs: args.cursorMs,
      }) ?? args.finalProfile;
    }
    return args.finalProfile;
  }, [
    args.enabled,
    queryEnabled,
    query.data,
    args.finalProfile,
    args.liveTrades,
    args.cursorMs,
    args.date,
    args.todayKst,
    args.segment,
    args.candles,
    args.rangeCount,
  ]);
}
```

- [ ] **Step 4: Run hook tests**

Run:

```bash
cd frontend && npx vitest run src/live/useVolumeDistributionCutoffProfile.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/useVolumeDistributionCutoffProfile.ts frontend/src/live/useVolumeDistributionCutoffProfile.test.tsx
git commit -m "feat: add shared cutoff volume distribution hook"
```

---

### Task 7: Wire Hook Into `/live`

**Files:**
- Modify: `frontend/src/live/LiveSidebar.tsx`
- Modify: `frontend/src/live/LiveSidebar.test.tsx`

**Interfaces:**
- Consumes: `useVolumeDistributionCutoffProfile`
- Consumes: `volumeDistributionHoverCutoffEnabled`

- [ ] **Step 1: Write failing `/live` tests**

In `LiveSidebar.test.tsx`, mock `useRange` or `useVolumeDistributionCutoffProfile` and add:

```ts
it('uses final volume distribution when hover cutoff mode is off', () => {
  useLivePageStore.setState({ volumeDistributionEnabled: true, volumeDistributionHoverCutoffEnabled: false });
  act(() => useLiveCursorStore.getState().setCursor(Date.UTC(2026, 4, 27, 0, 1, 0)));
  renderSidebar({ code: '005930', bundle: bundleWithFinalDistribution });
  expect(screen.getByTestId('volume-distribution-bar')).toHaveStyle({ width: '50%' });
});

it('uses hover-cutoff distribution when hover cutoff mode is on', () => {
  useLivePageStore.setState({ volumeDistributionEnabled: true, volumeDistributionHoverCutoffEnabled: true });
  mockedUseVolumeDistributionCutoffProfile.mockReturnValue(cutoffDistribution);
  act(() => useLiveCursorStore.getState().setCursor(Date.UTC(2026, 4, 27, 0, 1, 0)));
  renderSidebar({ code: '005930', bundle: bundleWithFinalDistribution });
  expect(mockedUseVolumeDistributionCutoffProfile).toHaveBeenCalled();
  expect(screen.getByTestId('volume-distribution-bar')).toHaveStyle({ width: '100%' });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd frontend && npx vitest run src/live/LiveSidebar.test.tsx
```

Expected: FAIL because LiveSidebar does not read the new setting or hook.

- [ ] **Step 3: Implement `/live` wiring**

In `LiveSidebar.tsx`, read:

```ts
const volumeDistributionHoverCutoffEnabled = useLivePageStore((s) => s.volumeDistributionHoverCutoffEnabled);
```

Find `todaySegment`, `todayCandles`, and selected date data already computed nearby. Add:

```ts
const cutoffVolumeDistribution = useVolumeDistributionCutoffProfile({
  enabled: volumeDistributionHoverCutoffEnabled && isSpot,
  code: stockCode,
  timeframe: spotTimeframe,
  date: activeVolumeDistributionDate,
  cursorMs,
  todayKst,
  rangeCount: volumeDistributionRangeCount,
  sourcePref,
  finalProfile: activeVolumeDistribution,
  priceRange: null,
  liveTrades: liveDistributionTrades,
  candles: activeBundle?.candles ?? [],
  segment: activeBundle?.segments.find((segment) => segment.date === activeVolumeDistributionDate) ?? null,
});
```

Import `useSourcePreferenceStore` if the hook needs explicit `sourcePref`.

Pass to card:

```tsx
profile={cutoffVolumeDistribution}
```

instead of `activeVolumeDistribution`.

- [ ] **Step 4: Run `/live` tests**

Run:

```bash
cd frontend && npx vitest run src/live/LiveSidebar.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/LiveSidebar.tsx frontend/src/live/LiveSidebar.test.tsx
git commit -m "feat: apply hover cutoff distribution on live sidebar"
```

---

### Task 8: Wire Hook Into v2 `/study` 복기뷰

**Files:**
- Modify: `frontend/src/studyViews/StudyReferenceDetailPanel.tsx`
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`

**Interfaces:**
- Consumes: `useVolumeDistributionCutoffProfile`
- Consumes: `volumeDistributionHoverCutoffEnabled`

- [ ] **Step 1: Write failing `/study` tests**

In `StudyPage.test.tsx`, add a test near existing volume-distribution tests:

```ts
it('uses hover-cutoff volume distribution for reference study views when enabled', () => {
  useLivePageStore.setState({
    volumeDistributionEnabled: true,
    volumeDistributionHoverCutoffEnabled: true,
    volumeDistributionRangeCount: 2,
  });
  useLiveCursorStore.getState().setCursor(HOVER_MS);
  mockedUseVolumeDistributionCutoffProfile.mockReturnValue(cutoffDistribution);
  renderPage('/study?view=view-ref');
  expect(mockedUseVolumeDistributionCutoffProfile).toHaveBeenCalled();
  expect(screen.getByTestId('volume-distribution-card')).toBeTruthy();
});
```

Use the existing mock style in `StudyPage.test.tsx`.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx
```

Expected: FAIL because `StudyReferenceDetailPanel` does not use the hook.

- [ ] **Step 3: Implement `/study` wiring**

In `StudyReferenceDetailPanel.tsx`, read:

```ts
const volumeDistributionHoverCutoffEnabled = useLivePageStore((s) => s.volumeDistributionHoverCutoffEnabled);
```

Use the source preference store:

```ts
const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
```

Add:

```ts
const cutoffVolumeDistribution = useVolumeDistributionCutoffProfile({
  enabled: volumeDistributionHoverCutoffEnabled && detailCursorMs !== null,
  code: save.code,
  timeframe: minuteTimeframe,
  date: volumeDistributionDate,
  cursorMs: detailCursorMs,
  todayKst: null,
  rangeCount: volumeDistributionRangeCount,
  sourcePref,
  finalProfile: volumeDistribution,
  priceRange: null,
  liveTrades: [],
  candles: bundle.candles,
  segment: bundle.segments.find((segment) => segment.date === volumeDistributionDate) ?? null,
});
```

Pass `cutoffVolumeDistribution` to `VolumeDistributionCard`.

- [ ] **Step 4: Run study tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/studyViews/StudyReferenceDetailPanel.tsx frontend/src/studyViews/StudyPage.test.tsx
git commit -m "feat: apply hover cutoff distribution on study reference views"
```

---

### Task 9: Full Verification

**Files:**
- No production file changes unless verification finds a bug.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified implementation.

- [ ] **Step 1: Run targeted backend tests**

Run:

```bash
uv run pytest tests/unit/api/test_range_volume_distribution_cutoff.py tests/unit/api/test_bundle_source_aware.py -q
```

Expected: PASS.

- [ ] **Step 2: Run targeted frontend tests**

Run:

```bash
cd frontend && npx vitest run \
  src/api/range.test.tsx \
  src/state/liveIndicatorsPersistence.test.ts \
  src/state/livePage.test.ts \
  src/live/continuousTradeVolumeDistribution.test.ts \
  src/live/useVolumeDistributionCutoffProfile.test.tsx \
  src/live/LiveSidebar.test.tsx \
  src/studyViews/StudyPage.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run broader smoke tests**

Run:

```bash
uv run pytest tests/unit/api/test_range_indicator_cache_integration.py tests/unit/api/test_bundle_source_aware.py -q
cd frontend && npx vitest run src/live/useLiveBundle.test.tsx src/studyViews/useStudyReferenceBundle.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Manual browser verification**

Start dev servers:

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
cd frontend && npm run dev
```

Open `http://localhost:5173/live`, select a stock with volume distribution data, enable `호버 시점 누적`, and hover three candles:

```text
early candle -> bars show smaller cumulative quantities
middle candle -> bars grow or redistribute within the same price rows
final candle -> bars match the final distribution
close line -> unchanged full selected-date line
vertical marker -> still follows cursor
```

Open a v2 `/study` 복기뷰 and repeat the same hover check. Confirm legacy snapshot study views do not issue cutoff requests.

- [ ] **Step 5: Commit verification fixes if needed**

If verification required fixes, stage the exact files changed by those fixes. For example, if the live sidebar and shared hook needed final corrections:

```bash
git add frontend/src/live/LiveSidebar.tsx frontend/src/live/useVolumeDistributionCutoffProfile.ts
git commit -m "fix: verify hover cutoff volume distribution"
```

If no fixes were needed, do not create an empty commit.
