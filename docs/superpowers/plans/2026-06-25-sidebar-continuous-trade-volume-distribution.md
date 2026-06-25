# Sidebar Continuous Trade Volume Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `연속체결 매물대 분포` sidebar card below `10호가` and above `거래원`, showing the hovered Stock-Date's full-day continuous-trade volume distribution with a dotted time marker.

**Architecture:** Add a new `volume_distributions` wire field on `RangeBundle`, computed only when `/api/range?volume_distribution_bins=N` is present. Backend computation uses a dedicated continuous-trade query so existing all-side `VolumeProfile` behavior remains untouched. Frontend settings opt into the field, render a compact sidebar card, recompute today's profile from live buffers when needed, and persist/restore the data through study snapshots.

**Tech Stack:** Python 3.11, FastAPI, Pydantic v2, DuckDB, pytest, React 18, TypeScript, TanStack Query, Zustand, Vitest, Testing Library.

## Global Constraints

- Canonical domain term: `연속체결 매물대 분포 (Continuous Trade Volume Distribution)`.
- Count only continuous-trading trade ticks: `side IN (1, -1)`.
- Exclude Auction Cross and single-price rows: `side = 0`.
- Price grid comes from the Stock-Date candle low-high range, not trade min/max.
- Range count is configurable from 5 to 30; default frontend setting is 10.
- `/api/range` computes the profiles only when `volume_distribution_bins` is present.
- Bars always represent the full hovered Stock-Date; hover time only moves the vertical dotted marker.
- Use per-segment session bounds and `frontend/src/util/sessionTime.ts`; do not hard-code 09:00/15:30.
- Study snapshots must round-trip settings and `volume_distributions`.

---

## File Structure

- `hoga/api/models.py`: add `VolumeDistributionBin`, `DayVolumeDistribution`, `RangeBundle.volume_distributions`, study snapshot fields, and indicator settings.
- `hoga/tables/trades.py`: add the dedicated continuous-trade distribution SQL helper; do not modify existing `query_volume_profile*` semantics.
- `hoga/api/bundle.py`: add dense-bin expansion for the new model and append profiles per valid Stock-Date when requested.
- `hoga/api/routes.py`: accept/validate optional `volume_distribution_bins` and forward it to `build_range_bundle`.
- `tests/test_tables_trades.py`: table-level filter/binning tests.
- `tests/test_api_range.py`: route opt-in and validation tests.
- `tests/hoga/api/test_bundle.py` or `tests/test_api_range.py`: bundle integration tests for profile generation.
- `frontend/src/api/types.ts`: add `VolumeDistributionBin` and `DayVolumeDistribution`, and `RangeBundle.volume_distributions`.
- `frontend/src/api/range.ts`: thread optional bins into query key and URL.
- `frontend/src/api/range.test.tsx`: cache-key/URL tests.
- `frontend/src/state/livePage.ts` and `frontend/src/state/liveIndicatorsPersistence.ts`: add persisted settings and normalization.
- `frontend/src/live/indicators/IndicatorPanel.tsx`: add indicator controls.
- `frontend/src/live/continuousTradeVolumeDistribution.ts`: pure frontend binning helper for today.
- `frontend/src/sidebar/VolumeDistributionCard.tsx`: visual card.
- `frontend/src/sidebar/CursorSidebar.tsx`: add the middle card prop and row layout.
- `frontend/src/live/LiveSidebar.tsx`: select profile and pass card in live mode.
- `frontend/src/studyViews/*`: study snapshot save/restore and detail panel wiring.

---

### Task 1: Backend Wire Models And Continuous-Trade Query

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `hoga/tables/trades.py`
- Test: `tests/test_tables_trades.py`
- Test: `tests/test_models.py`

**Interfaces:**
- Produces: `VolumeDistributionBin(price_low: int, price_high: int, qty: int)`.
- Produces: `DayVolumeDistribution(date: str, range_count: int, price_min: int, price_max: int, session_open_ms: int, session_close_ms: int, bins: list[VolumeDistributionBin])`.
- Produces: `query_continuous_trade_volume_distribution(con, *, path, price_lo, price_hi, bins, session_open_ms, session_close_ms) -> VolumeProfileBinning`.

- [ ] **Step 1: Write failing table tests**

Add tests to `tests/test_tables_trades.py` that create a temporary `trades.parquet` with:

```python
from hoga.tables.trades import Trade, write_parquet, query_continuous_trade_volume_distribution


def test_continuous_trade_volume_distribution_filters_side_and_session(tmp_path, duckdb_conn):
    path = tmp_path / "trades.parquet"
    write_parquet([
        Trade(ts_ms=85959000, seq=1, price=100, change_pct=0, qty=999, side=1, cum_vol=999, cum_trades=1, low_so_far=100, high_so_far=100, net_pressure=999, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90000000, seq=2, price=100, change_pct=0, qty=10, side=1, cum_vol=1009, cum_trades=2, low_so_far=100, high_so_far=100, net_pressure=1009, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90100000, seq=3, price=110, change_pct=0, qty=20, side=-1, cum_vol=1029, cum_trades=3, low_so_far=100, high_so_far=110, net_pressure=989, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90200000, seq=4, price=120, change_pct=0, qty=30, side=0, cum_vol=0, cum_trades=0, low_so_far=0, high_so_far=0, net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=153000000, seq=5, price=120, change_pct=0, qty=777, side=1, cum_vol=1806, cum_trades=4, low_so_far=100, high_so_far=120, net_pressure=1766, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
    ], path)

    got = query_continuous_trade_volume_distribution(
        duckdb_conn,
        path=path,
        price_lo=100,
        price_hi=120,
        bins=2,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert got.price_min == 100
    assert got.price_max == 120
    assert got.bins == [(0, 10), (1, 20)]
```

Add a second test for the top edge:

```python
def test_continuous_trade_volume_distribution_folds_high_price_into_last_bin(tmp_path, duckdb_conn):
    path = tmp_path / "trades.parquet"
    write_parquet([
        Trade(ts_ms=93000000, seq=1, price=120, change_pct=0, qty=33, side=1, cum_vol=33, cum_trades=1, low_so_far=120, high_so_far=120, net_pressure=33, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
    ], path)

    got = query_continuous_trade_volume_distribution(
        duckdb_conn,
        path=path,
        price_lo=100,
        price_hi=120,
        bins=2,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert got.bins == [(2, 33)]
```

The table helper may return sparse `bin_idx == bins` for the exact high edge, matching existing `VolumeProfileBinning` semantics. The bundle expansion folds that row into the final rendered bin.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pytest tests/test_tables_trades.py -k continuous_trade_volume_distribution -v
```

Expected: FAIL with `ImportError` or `AttributeError` because `query_continuous_trade_volume_distribution` does not exist.

- [ ] **Step 3: Add backend models**

In `hoga/api/models.py`, add near `TradeVolumePoc`:

```python
class VolumeDistributionBin(BaseModel):
    price_low: int
    price_high: int
    qty: int


class DayVolumeDistribution(BaseModel):
    date: str
    range_count: int = Field(ge=5, le=30)
    price_min: int
    price_max: int
    session_open_ms: int
    session_close_ms: int
    bins: list[VolumeDistributionBin]
```

Add to `RangeBundle`:

```python
volume_distributions: list[DayVolumeDistribution] = Field(default_factory=list)
```

- [ ] **Step 4: Add dedicated query helper**

In `hoga/tables/trades.py`, add:

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
) -> VolumeProfileBinning:
    """Bin continuous-trading trade qty into caller-supplied candle low/high range.

    Unlike query_volume_profile, this excludes Auction Cross rows (side=0) and
    bounds rows to the Stock-Date session. The caller expands sparse rows into
    the final wire model.
    """
    bin_width = (price_hi - price_lo) / bins
    if bin_width <= 0:
        bin_width = 1
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    session_open_intra_ms = _session_bound_to_intra_ms(session_open_ms)
    session_close_intra_ms = _session_bound_to_intra_ms(session_close_ms)
    rows = con.execute(
        f"""
        WITH continuous AS (
          SELECT price,
                 qty,
                 {intra_ms_expr} AS intra_ms
          FROM read_parquet(?)
          WHERE side IN (1, -1)
            AND price > 0
            AND qty > 0
        )
        SELECT FLOOR((price - {price_lo}) / {bin_width})::BIGINT AS bin_idx,
               SUM(qty) AS qty
        FROM continuous
        WHERE intra_ms >= ?
          AND intra_ms < ?
          AND price BETWEEN {price_lo} AND {price_hi}
        GROUP BY 1 ORDER BY 1
        """,
        [str(path), session_open_intra_ms, session_close_intra_ms],
    ).fetchall()
    return VolumeProfileBinning(
        price_min=price_lo,
        price_max=price_hi,
        bin_width=float(bin_width),
        bins=[(int(idx), int(qty)) for idx, qty in rows],
    )
```

- [ ] **Step 5: Run focused backend tests**

Run:

```bash
pytest tests/test_tables_trades.py -k continuous_trade_volume_distribution -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/models.py hoga/tables/trades.py tests/test_tables_trades.py
git commit -m "feat: add continuous trade distribution query"
```

---

### Task 2: Range API Opt-In And Bundle Generation

**Files:**
- Modify: `hoga/api/routes.py`
- Modify: `hoga/api/bundle.py`
- Test: `tests/test_api_range.py`
- Test: `tests/hoga/api/test_bundle.py`

**Interfaces:**
- Consumes: `query_continuous_trade_volume_distribution`.
- Produces: `build_range_bundle(..., volume_distribution_bins: int | None = None)`.
- Produces: `/api/range?...&volume_distribution_bins=N`.

- [ ] **Step 1: Write failing route tests**

Add to `tests/test_api_range.py`:

```python
def test_api_range_omits_volume_distribution_by_default(app_client: TestClient) -> None:
    captured: list[int | None] = []

    def _stub(engine, **kw):
        captured.append(kw.get("volume_distribution_bins"))
        return _build_range_bundle_stub(**kw)

    with patch("hoga.api.routes.build_range_bundle", side_effect=_stub):
        r = app_client.get("/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000")

    assert r.status_code == 200, r.text
    assert captured == [None]
    assert r.json()["volume_distributions"] == []


def test_api_range_threads_volume_distribution_bins(app_client: TestClient) -> None:
    captured: list[int | None] = []

    def _stub(engine, **kw):
        captured.append(kw.get("volume_distribution_bins"))
        return _build_range_bundle_stub(**kw)

    with patch("hoga.api.routes.build_range_bundle", side_effect=_stub):
        r = app_client.get("/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000&volume_distribution_bins=10")

    assert r.status_code == 200, r.text
    assert captured == [10]


def test_api_range_rejects_invalid_volume_distribution_bins(app_client: TestClient) -> None:
    for value in ("4", "31"):
        r = app_client.get(f"/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000&volume_distribution_bins={value}")
        assert r.status_code in (400, 422)
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pytest tests/test_api_range.py -k volume_distribution -v
```

Expected: FAIL because the route neither accepts nor forwards the new parameter.

- [ ] **Step 3: Implement route validation and forwarding**

In `hoga/api/routes.py`, update `api_range` signature:

```python
volume_distribution_bins: int | None = Query(None, ge=5, le=30),
```

Forward it:

```python
return build_range_bundle(
    engine,
    code=code,
    from_date=from_date,
    to_date=to_date,
    bucket_ms=bucket_ms,
    source_pref=source_pref,
    volume_distribution_bins=volume_distribution_bins,
)
```

Update `_build_range_bundle_stub` in `tests/test_api_range.py` to accept:

```python
def _build_range_bundle_stub(*, code, from_date, to_date, bucket_ms, source_pref="hogaplay", volume_distribution_bins=None):
    ...
```

- [ ] **Step 4: Implement bundle builder**

In `hoga/api/bundle.py`, import `DayVolumeDistribution` and `VolumeDistributionBin`.

Add helper:

```python
def _expand_distribution_bins(
    price_min: int,
    price_max: int,
    bin_width: float,
    sparse_bins: list[tuple[int, int]],
    range_count: int,
) -> list[VolumeDistributionBin]:
    rows: list[VolumeDistributionBin] = []
    qty_by_idx = [0 for _ in range(range_count)]
    for idx, qty in sparse_bins:
        if idx < 0:
            continue
        qty_by_idx[min(idx, range_count - 1)] += qty
    for i, qty in enumerate(qty_by_idx):
        low = int(price_min + i * bin_width)
        high = price_max if i == range_count - 1 else int(price_min + (i + 1) * bin_width)
        rows.append(VolumeDistributionBin(price_low=low, price_high=high, qty=qty))
    return rows
```

Add builder:

```python
def build_volume_distribution_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    session_open_ms: int,
    session_close_ms: int,
    range_count: int,
) -> DayVolumeDistribution | None:
    code_dir = engine.parquet_dir(date, code, source)
    candles_path = code_dir / "candles.parquet"
    trades_path = code_dir / "trades.parquet"
    if not candles_path.exists() or not trades_path.exists():
        return None
    price_range = candles_tbl.query_price_range(engine.conn, path=candles_path)
    if price_range is None:
        return None
    price_min, price_max = price_range
    binning = trades_tbl.query_continuous_trade_volume_distribution(
        engine.conn,
        path=trades_path,
        price_lo=price_min,
        price_hi=price_max,
        bins=range_count,
        session_open_ms=session_open_ms,
        session_close_ms=session_close_ms,
    )
    return DayVolumeDistribution(
        date=date,
        range_count=range_count,
        price_min=price_min,
        price_max=price_max,
        session_open_ms=session_open_ms,
        session_close_ms=session_close_ms,
        bins=_expand_distribution_bins(price_min, price_max, binning.bin_width, binning.bins, range_count),
    )
```

Update `build_range_bundle` signature and loop:

```python
volume_distribution_bins: int | None = None,
```

Initialize:

```python
volume_distributions: list[DayVolumeDistribution] = []
```

Inside the valid-date loop, after `segments.append(...)` and when `volume_distribution_bins is not None`:

```python
profile = build_volume_distribution_slice(
    engine,
    code=code,
    date=d,
    source=source,
    session_open_ms=int(meta["regular_session_open_ms"]),
    session_close_ms=int(meta["regular_session_close_ms"]),
    range_count=volume_distribution_bins,
)
if profile is not None:
    volume_distributions.append(profile)
```

Return it in both success and `_empty_range_bundle`.

- [ ] **Step 5: Write bundle integration test**

Add a focused test that patches `build_volume_distribution_slice` and asserts it is not called when `volume_distribution_bins=None`, and called once when `10`.

Command:

```bash
pytest tests/test_api_range.py tests/hoga/api/test_bundle.py -k volume_distribution -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/routes.py hoga/api/bundle.py tests/test_api_range.py tests/hoga/api/test_bundle.py
git commit -m "feat: add range volume distribution profiles"
```

---

### Task 3: Frontend Types, Range Query, And Indicator Settings

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/range.ts`
- Modify: `frontend/src/api/range.test.tsx`
- Modify: `frontend/src/state/livePage.ts`
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Test: `frontend/src/state/liveIndicatorsPersistence.test.ts`
- Test: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

**Interfaces:**
- Produces: `DayVolumeDistribution` TypeScript type.
- Produces: `useRange(..., options?: { volumeDistributionBins?: number | null })`.
- Produces settings: `volumeDistributionEnabled`, `volumeDistributionRangeCount`, `volumeDistributionColor`, `volumeDistributionMaxColor`.

- [ ] **Step 1: Write failing range-query tests**

In `frontend/src/api/range.test.tsx`, add:

```ts
it('omits volume_distribution_bins when not requested', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
  renderHook(
    () => useRange('005930', '20260512', '20260512', '1m'),
    { wrapper: makeWrapper() },
  );
  await waitFor(() => expect(spy).toHaveBeenCalled());
  expect(spy.mock.calls[0][0]).not.toContain('volume_distribution_bins=');
});

it('threads volume_distribution_bins into query string', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
  renderHook(
    () => useRange('005930', '20260512', '20260512', '1m', undefined, null, { volumeDistributionBins: 20 }),
    { wrapper: makeWrapper() },
  );
  await waitFor(() => expect(spy).toHaveBeenCalled());
  expect(spy.mock.calls[0][0]).toContain('&volume_distribution_bins=20');
});
```

Update `fakeBundle` with `volume_distributions: []`.

- [ ] **Step 2: Run frontend range tests to verify failure**

Run:

```bash
cd frontend && npm test -- range.test.tsx
```

Expected: FAIL until `useRange` supports the option and `RangeBundle` includes the new field.

- [ ] **Step 3: Add frontend types**

In `frontend/src/api/types.ts`:

```ts
export type VolumeDistributionBin = {
  price_low: number;
  price_high: number;
  qty: number;
};

export type DayVolumeDistribution = {
  date: string;
  range_count: number;
  price_min: number;
  price_max: number;
  session_open_ms: number;
  session_close_ms: number;
  bins: VolumeDistributionBin[];
};
```

Add to `RangeBundle`:

```ts
volume_distributions: DayVolumeDistribution[];
```

- [ ] **Step 4: Thread optional bins through `useRange`**

Update `frontend/src/api/range.ts` signature:

```ts
export function useRange(
  code: string | null,
  from: string | null,
  to: string | null,
  timeframe: Timeframe | null,
  priceRange?: { min: number; max: number },
  todayKst?: string | null,
  options?: { volumeDistributionBins?: number | null },
)
```

Add:

```ts
const volumeDistributionBins = options?.volumeDistributionBins ?? null;
const volumeDistributionQs =
  volumeDistributionBins != null ? `&volume_distribution_bins=${volumeDistributionBins}` : '';
```

Add `volumeDistributionBins` to the query key, and append `${volumeDistributionQs}` before `source_pref`.

- [ ] **Step 5: Add persisted settings**

In the live page state/persistence files, add defaults:

```ts
volumeDistributionEnabled: true,
volumeDistributionRangeCount: 10,
volumeDistributionColor: '#64748B',
volumeDistributionMaxColor: '#EAB308',
```

Normalize persisted range count:

```ts
function normalizeVolumeDistributionRangeCount(value: unknown): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(n)) return 10;
  return Math.min(30, Math.max(5, n));
}
```

Normalize colors with the existing hex-color helper or equivalent local pattern already used by MA/POC settings.

- [ ] **Step 6: Add indicator UI**

In `IndicatorPanel.tsx`, add a row under the hoga/sidebar indicator section:

```tsx
<label>
  <input
    type="checkbox"
    checked={state.volumeDistributionEnabled}
    onChange={(event) => setState({ volumeDistributionEnabled: event.currentTarget.checked })}
  />
  연속체결 매물대 분포
</label>
```

Add range count numeric control with min `5`, max `30`, and two color pickers following existing indicator config row patterns.

- [ ] **Step 7: Run focused frontend tests**

Run:

```bash
cd frontend && npm test -- range.test.tsx liveIndicatorsPersistence.test.ts IndicatorPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/range.ts frontend/src/api/range.test.tsx frontend/src/state/livePage.ts frontend/src/state/liveIndicatorsPersistence.ts frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/state/liveIndicatorsPersistence.test.ts frontend/src/live/indicators/IndicatorPanel.test.tsx
git commit -m "feat: add volume distribution settings"
```

---

### Task 4: Pure Frontend Binning And Sidebar Card

**Files:**
- Create: `frontend/src/live/continuousTradeVolumeDistribution.ts`
- Test: `frontend/src/live/continuousTradeVolumeDistribution.test.ts`
- Create: `frontend/src/sidebar/VolumeDistributionCard.tsx`
- Test: `frontend/src/sidebar/VolumeDistributionCard.test.tsx`
- Modify: `frontend/src/sidebar/CursorSidebar.tsx`
- Test: add or update `frontend/src/live/LiveSidebar.test.tsx` or create `frontend/src/sidebar/CursorSidebar.test.tsx`.

**Interfaces:**
- Produces: `computeContinuousTradeVolumeDistribution(args)`.
- Produces: `<VolumeDistributionCard profile cursorMs color maxColor />`.
- Consumes: `DayVolumeDistribution`.

- [ ] **Step 1: Write pure helper tests**

Create `frontend/src/live/continuousTradeVolumeDistribution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeContinuousTradeVolumeDistribution } from './continuousTradeVolumeDistribution';

describe('computeContinuousTradeVolumeDistribution', () => {
  it('bins side +/-1 trades and excludes side 0', () => {
    const profile = computeContinuousTradeVolumeDistribution({
      date: '20260625',
      candles: [{ ts_ms: 1, open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      trades: [
        { t_ms: 90_000_000, price: 100, qty: 10, side: 1 },
        { t_ms: 90_001_000, price: 110, qty: 20, side: -1 },
        { t_ms: 90_002_000, price: 120, qty: 30, side: 0 },
      ],
      rangeCount: 2,
      segment: { date: '20260625', session_open_ms: 90_000_000, session_close_ms: 153_000_000 },
    });

    expect(profile?.bins.map((b) => b.qty)).toEqual([10, 20]);
  });

  it('folds a high-price trade into the last bin', () => {
    const profile = computeContinuousTradeVolumeDistribution({
      date: '20260625',
      candles: [{ ts_ms: 1, open: 100, high: 120, low: 100, close: 120, vol_a: 0, vol_b: 0 }],
      trades: [{ t_ms: 90_000_000, price: 120, qty: 33, side: 1 }],
      rangeCount: 2,
      segment: { date: '20260625', session_open_ms: 90_000_000, session_close_ms: 153_000_000 },
    });

    expect(profile?.bins.map((b) => b.qty)).toEqual([0, 33]);
  });
});
```

- [ ] **Step 2: Implement pure helper**

Create `frontend/src/live/continuousTradeVolumeDistribution.ts`:

```ts
import type { Candle, DayVolumeDistribution, RangeSegment } from '../api/types';

type ContinuousTradeLike = {
  t_ms: number;
  price: number;
  qty: number;
  side: number;
};

export function computeContinuousTradeVolumeDistribution(args: {
  date: string;
  candles: readonly Candle[];
  trades: readonly ContinuousTradeLike[];
  rangeCount: number;
  segment: RangeSegment;
}): DayVolumeDistribution | null {
  const { date, candles, trades, rangeCount, segment } = args;
  const lows = candles.map((c) => c.low).filter(Number.isFinite);
  const highs = candles.map((c) => c.high).filter(Number.isFinite);
  if (lows.length === 0 || highs.length === 0) return null;
  const priceMin = Math.min(...lows);
  const priceMax = Math.max(...highs);
  let binWidth = (priceMax - priceMin) / rangeCount;
  if (binWidth <= 0) binWidth = 1;
  const qtyByBin = Array.from({ length: rangeCount }, () => 0);
  for (const trade of trades) {
    if (trade.side !== 1 && trade.side !== -1) continue;
    if (trade.qty <= 0 || trade.price <= 0) continue;
    if (trade.t_ms < segment.session_open_ms || trade.t_ms >= segment.session_close_ms) continue;
    if (trade.price < priceMin || trade.price > priceMax) continue;
    const idx = Math.floor((trade.price - priceMin) / binWidth);
    qtyByBin[Math.min(rangeCount - 1, Math.max(0, idx))] += trade.qty;
  }
  return {
    date,
    range_count: rangeCount,
    price_min: priceMin,
    price_max: priceMax,
    session_open_ms: segment.session_open_ms,
    session_close_ms: segment.session_close_ms,
    bins: qtyByBin.map((qty, i) => ({
      price_low: Math.floor(priceMin + i * binWidth),
      price_high: i === rangeCount - 1 ? priceMax : Math.floor(priceMin + (i + 1) * binWidth),
      qty,
    })),
  };
}
```

- [ ] **Step 3: Write card tests**

Create `frontend/src/sidebar/VolumeDistributionCard.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VolumeDistributionCard } from './VolumeDistributionCard';
import type { DayVolumeDistribution } from '../api/types';

const profile: DayVolumeDistribution = {
  date: '20260625',
  range_count: 2,
  price_min: 100,
  price_max: 120,
  session_open_ms: 90_000_000,
  session_close_ms: 153_000_000,
  bins: [
    { price_low: 100, price_high: 110, qty: 10 },
    { price_low: 110, price_high: 120, qty: 30 },
  ],
};

it('renders high price rows first and highlights max bin', () => {
  render(<VolumeDistributionCard profile={profile} cursorMs={100_000_000} color="#64748B" maxColor="#EAB308" />);
  const rows = screen.getAllByTestId('volume-distribution-row');
  expect(rows[0]).toHaveTextContent('110');
  expect(rows[0]).toHaveTextContent('120');
  expect(screen.getByTestId('volume-distribution-max-bar')).toBeInTheDocument();
});

it('shows marker only inside session bounds', () => {
  const { rerender } = render(<VolumeDistributionCard profile={profile} cursorMs={100_000_000} color="#64748B" maxColor="#EAB308" />);
  expect(screen.getByTestId('volume-distribution-cursor-marker')).toBeInTheDocument();
  rerender(<VolumeDistributionCard profile={profile} cursorMs={200_000_000} color="#64748B" maxColor="#EAB308" />);
  expect(screen.queryByTestId('volume-distribution-cursor-marker')).toBeNull();
});
```

- [ ] **Step 4: Implement card and sidebar layout**

Create `VolumeDistributionCard.tsx` with:

```tsx
import type { DayVolumeDistribution } from '../api/types';
import { formatQtyCompact } from '../util/formatQtyCompact';

type Props = {
  profile: DayVolumeDistribution | null | undefined;
  cursorMs: number | null;
  color: string;
  maxColor: string;
};

export function VolumeDistributionCard({ profile, cursorMs, color, maxColor }: Props) {
  if (profile === undefined) {
    return <div className="grid h-full place-items-center text-xs text-fg-dimmer">—</div>;
  }
  if (profile === null || profile.bins.length === 0) {
    return <div className="grid h-full place-items-center text-xs text-fg-dimmer">매물대 분포 없음</div>;
  }
  const maxQty = Math.max(0, ...profile.bins.map((b) => b.qty));
  const rows = [...profile.bins].reverse();
  const markerVisible =
    cursorMs != null &&
    cursorMs >= profile.session_open_ms &&
    cursorMs <= profile.session_close_ms &&
    profile.session_close_ms > profile.session_open_ms;
  const markerPct = markerVisible
    ? ((cursorMs - profile.session_open_ms) / (profile.session_close_ms - profile.session_open_ms)) * 100
    : 0;
  return (
    <div data-testid="volume-distribution-card" className="relative flex h-full min-h-0 flex-col gap-1 px-2 py-2 text-[11px]">
      {markerVisible && (
        <div
          data-testid="volume-distribution-cursor-marker"
          className="pointer-events-none absolute bottom-2 top-2 border-l border-dotted border-accent"
          style={{ left: `${Math.min(100, Math.max(0, markerPct))}%` }}
        />
      )}
      {rows.map((bin) => {
        const isMax = maxQty > 0 && bin.qty === maxQty;
        const width = maxQty > 0 ? `${(bin.qty / maxQty) * 100}%` : '0%';
        return (
          <div key={`${bin.price_low}-${bin.price_high}`} data-testid="volume-distribution-row" className="grid min-h-0 grid-cols-[72px_1fr_52px] items-center gap-2">
            <div className="truncate font-mono text-fg-dim">{bin.price_low}-{bin.price_high}</div>
            <div className="h-2 overflow-hidden rounded-sm bg-bg">
              <div
                data-testid={isMax ? 'volume-distribution-max-bar' : 'volume-distribution-bar'}
                className="h-full"
                style={{ width, backgroundColor: isMax ? maxColor : color }}
              />
            </div>
            <div className="text-right font-mono text-fg-dimmer">{formatQtyCompact(bin.qty)}</div>
          </div>
        );
      })}
    </div>
  );
}
```

Update `CursorSidebar.tsx` props and layout:

```tsx
type Props = {
  orderbook?: ReactNode;
  volumeDistribution?: ReactNode;
  brokers?: ReactNode;
};
```

Render three cards:

```tsx
className="grid grid-rows-[minmax(480px,1.8fr)_minmax(132px,0.5fr)_minmax(180px,1.2fr)] gap-[var(--space-sm)] p-[var(--space-sm)] bg-bg h-full min-h-0"
```

with:

```tsx
<SidebarCard label="연속체결 매물대 분포" testId="card-volume-distribution">
  {volumeDistribution ?? <Placeholder />}
</SidebarCard>
```

- [ ] **Step 5: Run focused frontend tests**

Run:

```bash
cd frontend && npm test -- continuousTradeVolumeDistribution.test.ts VolumeDistributionCard.test.tsx LiveSidebar.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/continuousTradeVolumeDistribution.ts frontend/src/live/continuousTradeVolumeDistribution.test.ts frontend/src/sidebar/VolumeDistributionCard.tsx frontend/src/sidebar/VolumeDistributionCard.test.tsx frontend/src/sidebar/CursorSidebar.tsx frontend/src/live/LiveSidebar.test.tsx
git commit -m "feat: add volume distribution sidebar card"
```

---

### Task 5: Live Wiring And Today Recompute

**Files:**
- Modify: `frontend/src/live/useLiveBundle.ts`
- Modify: `frontend/src/live/buildLiveBundle.ts`
- Modify: `frontend/src/live/LiveSidebar.tsx`
- Test: `frontend/src/live/buildLiveBundle.test.ts`
- Test: `frontend/src/live/LiveSidebar.test.tsx`

**Interfaces:**
- Consumes: `RangeBundle.volume_distributions`.
- Consumes: `computeContinuousTradeVolumeDistribution`.
- Produces: live sidebar `volumeDistribution` prop.

- [ ] **Step 1: Write failing live wiring tests**

In `frontend/src/live/LiveSidebar.test.tsx`, add an assertion that a rendered sidebar includes `card-volume-distribution` between orderbook and brokers.

In `frontend/src/live/buildLiveBundle.test.ts`, add a test that past bundle `volume_distributions` are preserved when no today recompute is needed.

- [ ] **Step 2: Pass settings into `useRange`**

In `useLiveBundle.ts`, read:

```ts
const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
```

Pass:

```ts
{ volumeDistributionBins: volumeDistributionEnabled ? volumeDistributionRangeCount : null }
```

to `useRange`.

- [ ] **Step 3: Preserve profiles in build bundle**

In `buildLiveBundle.ts`, add:

```ts
volume_distributions: pastBundle?.volume_distributions ?? [],
```

to returned `RangeBundle` structures.

- [ ] **Step 4: Derive active profile in `LiveSidebar`**

In `LiveSidebar.tsx`, import `VolumeDistributionCard`, use the active bundle or `live` structure that contains `volume_distributions`, and select by cursor KST date. If the current `LiveSidebar` does not receive the range bundle, extend its props with the profile array and today candles/trades in the caller; keep derivation memoized by profile arrays and settings, not by unrelated sidebar fetch state.

Render:

```tsx
volumeDistribution={
  <VolumeDistributionCard
    profile={activeVolumeDistribution}
    cursorMs={isSpot ? cursorMs : brokerCursorMs}
    color={volumeDistributionColor}
    maxColor={volumeDistributionMaxColor}
  />
}
```

- [ ] **Step 5: Add today recompute only where live trade data is available**

When the active date is today and live trades/candles are available, call:

```ts
computeContinuousTradeVolumeDistribution({
  date: todayDate,
  candles: todayCandles,
  trades: live.trade,
  rangeCount: volumeDistributionRangeCount,
  segment: todaySegment,
})
```

Use the computed profile if non-null; otherwise fall back to the persisted profile from `pastBundle.volume_distributions`.

- [ ] **Step 6: Run focused live tests**

Run:

```bash
cd frontend && npm test -- useLiveBundle.test.tsx buildLiveBundle.test.ts LiveSidebar.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/live/useLiveBundle.ts frontend/src/live/buildLiveBundle.ts frontend/src/live/LiveSidebar.tsx frontend/src/live/useLiveBundle.test.tsx frontend/src/live/buildLiveBundle.test.ts frontend/src/live/LiveSidebar.test.tsx
git commit -m "feat: wire live volume distribution"
```

---

### Task 6: Study Snapshot Round-Trip

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `frontend/src/api/studyViews.ts`
- Modify: `frontend/src/studyViews/useStudySnapshotCapture.ts`
- Modify: `frontend/src/studyViews/studySnapshotAdapter.ts`
- Modify: `frontend/src/studyViews/StudyDetailPanel.tsx`
- Test: `tests/api/test_study_views.py`
- Test: `frontend/src/studyViews/useStudySnapshotCapture.test.ts`
- Test: `frontend/src/studyViews/studySnapshotAdapter.test.ts`

**Interfaces:**
- Consumes: `DayVolumeDistribution`.
- Produces: saved `StudySnapshotBundle.volume_distributions`.
- Produces: restored `RangeBundle.volume_distributions`.

- [ ] **Step 1: Write failing snapshot tests**

In frontend capture test, construct a bundle with:

```ts
volume_distributions: [{
  date: '20260625',
  range_count: 10,
  price_min: 100,
  price_max: 120,
  session_open_ms: 90_000_000,
  session_close_ms: 153_000_000,
  bins: [{ price_low: 100, price_high: 102, qty: 10 }],
}]
```

Assert `buildStudySnapshotRequest(...).snapshot.bundle.volume_distributions` contains that entry when its date is in `segments`.

In adapter test, assert `studySnapshotBundleToRangeBundle(snapshot).volume_distributions` equals the saved array.

- [ ] **Step 2: Add Python snapshot fields**

In `StudyIndicatorState`, add:

```python
volume_distribution_enabled: bool = True
volume_distribution_range_count: int = Field(default=10, ge=5, le=30)
volume_distribution_color: str = Field(default="#64748B", pattern=r"^#[0-9A-Fa-f]{6}$")
volume_distribution_max_color: str = Field(default="#EAB308", pattern=r"^#[0-9A-Fa-f]{6}$")
```

In `StudySnapshotBundle`, add:

```python
volume_distributions: list[DayVolumeDistribution] = Field(default_factory=list)
```

- [ ] **Step 3: Add TypeScript snapshot fields**

In `frontend/src/api/studyViews.ts`, import `DayVolumeDistribution` and add:

```ts
volume_distribution_enabled?: boolean;
volume_distribution_range_count?: number;
volume_distribution_color?: string;
volume_distribution_max_color?: string;
```

to `StudyIndicatorState`, and:

```ts
volume_distributions?: DayVolumeDistribution[];
```

to `StudySnapshotBundle`.

- [ ] **Step 4: Capture and restore profiles**

In `useStudySnapshotCapture.ts`:

```ts
volume_distributions: (args.bundle.volume_distributions ?? []).filter((p) => segmentDates.has(p.date)),
```

In `studySnapshotAdapter.ts` returned `RangeBundle`:

```ts
volume_distributions: snapshot.volume_distributions ?? [],
```

In `StudyDetailPanel.tsx`, accept `volumeDistributions?: DayVolumeDistribution[]` or add it to `StudySnapshotDetailInput`, select by `activeSegment.date`, and pass a `VolumeDistributionCard`.

- [ ] **Step 5: Run study tests**

Run:

```bash
pytest tests/api/test_study_views.py -k volume_distribution -v
cd frontend && npm test -- useStudySnapshotCapture.test.ts studySnapshotAdapter.test.ts StudyDetailPanel
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/models.py frontend/src/api/studyViews.ts frontend/src/studyViews/useStudySnapshotCapture.ts frontend/src/studyViews/studySnapshotAdapter.ts frontend/src/studyViews/StudyDetailPanel.tsx tests/api/test_study_views.py frontend/src/studyViews/useStudySnapshotCapture.test.ts frontend/src/studyViews/studySnapshotAdapter.test.ts
git commit -m "feat: persist volume distribution in study views"
```

---

### Task 7: Final Verification

**Files:**
- Read: `docs/superpowers/specs/2026-06-25-sidebar-volume-distribution-design.md`
- Read: `CONTEXT.md`

**Interfaces:**
- Confirms every spec requirement has shipped.

- [ ] **Step 1: Run focused backend suite**

```bash
pytest tests/test_tables_trades.py tests/test_api_range.py tests/hoga/api/test_bundle.py tests/api/test_study_views.py -k "volume_distribution or continuous_trade_volume_distribution" -v
```

Expected: PASS.

- [ ] **Step 2: Run focused frontend suite**

```bash
cd frontend && npm test -- range.test.tsx continuousTradeVolumeDistribution.test.ts VolumeDistributionCard.test.tsx LiveSidebar.test.tsx buildLiveBundle.test.ts useLiveBundle.test.tsx useStudySnapshotCapture.test.ts studySnapshotAdapter.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run type/build check**

```bash
cd frontend && npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual browser check**

Start the app:

```bash
cd frontend && npm run dev -- --host 0.0.0.0
```

In `/live`:

- Hover a past candle; `10호가 -> 연속체결 매물대 분포 -> 거래원` order is visible.
- Move within the same day; bar lengths stay stable and the dotted marker moves.
- Change range count from 10 to 20; `/api/range` refetches and the card renders 20 rows.
- Confirm max-volume row uses `#EAB308` by default.
- Save a study view, open `/study`, hover a saved bucket, and confirm the card renders without live fetches.

- [ ] **Step 5: Commit final polish**

```bash
git status --short
git add docs/superpowers/specs/2026-06-25-sidebar-volume-distribution-design.md CONTEXT.md
git commit -m "docs: plan sidebar volume distribution implementation"
```

Only run this commit if the current branch still has the spec/context docs unstaged from the planning pass. If implementation tasks already included these docs, skip this commit.

---

## Self-Review

- Spec coverage: backend query, API opt-in, frontend settings, sidebar placement, live today recompute, marker behavior, study snapshot restore, and tests all have tasks.
- Placeholder scan: no task uses `TBD`, open-ended "handle edge cases", or unspecified test commands.
- Type consistency: Python `DayVolumeDistribution` mirrors TypeScript `DayVolumeDistribution`; route parameter is consistently `volume_distribution_bins`; settings names are consistently `volumeDistribution*` in frontend state and `volume_distribution_*` in study snapshot wire.
