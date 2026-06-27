# Volume Distribution Closing Auction Cutoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exclude only the closing auction tick data from the continuous trade volume distribution and trade-volume POC calculations, using the same structural orderbook boundary concept as quote totals.

**Architecture:** Past parquet calculations derive a per-day `first_single_price_book_time` from `snapshots.parquet` and use it as an exclusive upper bound for trade aggregation. Today/live calculations derive the same cutoff from live orderbook snapshots already passed to the frontend. Intraday VI is not excluded by this feature; only the trailing single-price book run after the final normal 10-level orderbook is excluded.

**Tech Stack:** Python 3.14, DuckDB, PyArrow parquet, pytest, TypeScript, React, Vitest.

## Global Constraints

- Do not use a fixed `15:20` cutoff.
- Do not use `session_close_ms - 10min` as the authoritative cutoff.
- Do not use `phase === "regular"` for auction exclusion; it includes the whole 09:00-15:30 regular session.
- Keep `side IN (1, -1)` / `side === 1 || side === -1` filters.
- Exclude only closing auction tail. Do not exclude intraday VI.
- If no orderbook snapshot exists for a day, preserve existing behavior rather than dropping all distribution data.

## Resolved Grilling Decisions

- Use the orderbook structural boundary as the source of truth: normal 10-level book vs trailing single-price 3-level book.
- Use `first_trailing_single_price_book_ms` as an exclusive cutoff, not `last_continuous_ms` as an inclusive cutoff. This keeps valid continuous trades that occur between the last normal orderbook snapshot and the first single-price orderbook snapshot.
- Detect the closing auction tail as the first single-price snapshot after the final normal orderbook before session close. Do not use the first single-price snapshot of the day, because that could be an intraday VI.
- Live/today behavior is naturally progressive: before the trailing single-price snapshot arrives, no structural cutoff exists and existing session-close behavior remains; after it arrives, new matching trade ticks at or after that timestamp are excluded.
- Naming is `continuous_before_ms` / `continuousBeforeMs` to make the exclusive upper bound obvious.

---

## File Structure

- Modify `hoga/tables/snapshots.py`
  - Add a public helper that returns the first trailing single-price-book intra-ms after the final continuous book at or before session close.
  - Reuse the existing deep-book predicate so quote totals and volume distribution share the same structural definition.
- Modify `hoga/api/bundle.py`
  - Compute the cutoff from `snapshots.parquet` when building `volume_distributions` and `trade_volume_pocs`.
  - Pass the cutoff into trade-table query functions.
- Modify `hoga/tables/trades.py`
  - Add optional `continuous_before_ms` parameters to `query_continuous_trade_volume_distribution` and `query_trade_volume_poc`.
  - Use the cutoff as an exclusive upper bound when present; otherwise keep `session_close_ms`.
- Modify `tests/test_tables_trades.py`
  - Lock the backend trade filtering behavior with direct DuckDB tests.
- Modify `tests/hoga/api/test_bundle.py`
  - Lock the integrated bundle behavior: snapshots determine the closing-auction cutoff for distribution and POC.
- Modify `frontend/src/live/continuousTradeVolumeDistribution.ts`
  - Add a cutoff helper using live orderbook snapshots and pass it into recomputation/merge.
- Modify `frontend/src/live/LiveSidebar.tsx`
  - Pass `live.ob` into the volume distribution selector/recompute path.
- Modify `frontend/src/live/continuousTradeVolumeDistribution.test.ts`
  - Lock live cutoff behavior.

---

### Task 1: Backend Trade Queries Accept Structural Cutoff

**Files:**
- Modify: `hoga/tables/trades.py`
- Test: `tests/test_tables_trades.py`

**Interfaces:**
- Consumes: optional `continuous_before_ms: int | None` in native HHMMSSmmm format, exclusive.
- Produces:
  - `query_trade_volume_poc(..., continuous_before_ms: int | None = None) -> TradeVolumePocRow | None`
  - `query_continuous_trade_volume_distribution(..., continuous_before_ms: int | None = None) -> VolumeProfileBinning`

- [ ] **Step 1: Write failing tests**

Add these tests near the existing trade-volume POC and continuous distribution tests in `tests/test_tables_trades.py`:

```python
def test_query_trade_volume_poc_uses_continuous_before_cutoff(tmp_path: Path) -> None:
    import duckdb

    from hoga.tables.trades import query_trade_volume_poc

    p = tmp_path / "trades.parquet"
    write_parquet([
        _price_trade(ts_ms=151_900_000, seq=1, price=72_100, qty=20, side=1),
        _price_trade(ts_ms=152_001_000, seq=2, price=70_000, qty=1_000, side=1),
    ], p)

    row = query_trade_volume_poc(
        duckdb.connect(),
        path=p,
        price_lo=70_000,
        price_hi=72_100,
        bins=2,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
        continuous_before_ms=152_001_000,
    )

    assert row is not None
    assert row.low_price == 71_050
    assert row.high_price == 72_100
    assert row.qty == 20


def test_continuous_trade_volume_distribution_uses_continuous_before_cutoff(tmp_path: Path) -> None:
    import duckdb

    from hoga.tables.trades import Trade, query_continuous_trade_volume_distribution

    path = tmp_path / "trades.parquet"
    write_parquet([
        Trade(ts_ms=151_959_000, seq=1, price=110, change_pct=0, qty=20, side=1,
              cum_vol=20, cum_trades=1, low_so_far=110, high_so_far=110,
              net_pressure=20, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=152_001_000, seq=2, price=100, change_pct=0, qty=999, side=1,
              cum_vol=1019, cum_trades=2, low_so_far=100, high_so_far=110,
              net_pressure=1019, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
    ], path)

    got = query_continuous_trade_volume_distribution(
        duckdb.connect(),
        path=path,
        price_lo=100,
        price_hi=120,
        bins=2,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
        continuous_before_ms=152_001_000,
    )

    assert got.bins == [(1, 20)]
    assert got.max_intra_ms == 55_199_000
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run --extra dev pytest tests/test_tables_trades.py -k "continuous_before_cutoff" -q
```

Expected: FAIL with `unexpected keyword argument 'continuous_before_ms'`.

- [ ] **Step 3: Implement optional cutoff**

In `hoga/tables/trades.py`, change both signatures and compute the effective upper bound:

```python
def query_trade_volume_poc(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    price_lo: int,
    price_hi: int,
    bins: int,
    session_open_ms: int,
    session_close_ms: int,
    continuous_before_ms: int | None = None,
) -> TradeVolumePocRow | None:
    ...
    session_close_intra_ms = _session_bound_to_intra_ms(session_close_ms)
    upper_bound_intra_ms = (
        _session_bound_to_intra_ms(continuous_before_ms)
        if continuous_before_ms is not None
        else session_close_intra_ms
    )
```

Then replace the SQL parameter that currently passes `session_close_intra_ms` with `upper_bound_intra_ms`. The predicate remains `intra_ms < ?`, so the first single-price book timestamp is excluded:

```python
            session_open_intra_ms,
            upper_bound_intra_ms,
```

Apply the same signature and bound logic to `query_continuous_trade_volume_distribution`:

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
    continuous_before_ms: int | None = None,
) -> VolumeProfileBinning:
    ...
    session_close_intra_ms = _session_bound_to_intra_ms(session_close_ms)
    upper_bound_intra_ms = (
        _session_bound_to_intra_ms(continuous_before_ms)
        if continuous_before_ms is not None
        else session_close_intra_ms
    )
```

Then pass `upper_bound_intra_ms` as the second bound for the `intra_ms < ?` predicate.

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
uv run --extra dev pytest tests/test_tables_trades.py -k "continuous_before_cutoff or trade_volume_poc" -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/tables/trades.py tests/test_tables_trades.py
git commit -m "feat: support continuous trade cutoff in trade aggregations"
```

---

### Task 2: Backend Bundle Derives Cutoff From Snapshots

**Files:**
- Modify: `hoga/tables/snapshots.py`
- Modify: `hoga/api/bundle.py`
- Test: `tests/hoga/api/test_bundle.py`

**Interfaces:**
- Produces: `snapshots_tbl.query_first_trailing_single_price_book_intra_ms(con, *, path: Path, session_close_ms: int | None) -> int | None`
- Consumes: Task 1 `continuous_before_ms`.

- [ ] **Step 1: Expose first trailing single-price helper**

In `hoga/tables/snapshots.py`, add a public helper near `_last_continuous_intra_ms`:

```python
def query_first_trailing_single_price_book_intra_ms(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    session_close_ms: int | None,
) -> int | None:
    """Return the first shallow book after the final deep book before close."""
    last_continuous = _last_continuous_intra_ms(
        con,
        path=path,
        session_close_ms=session_close_ms,
    )
    if last_continuous is None or session_close_ms is None:
        return None
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    close_intra_sql = hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))
    row = con.execute(
        f"SELECT min({intra_ms_expr}) FROM read_parquet(?) "
        f"WHERE NOT ({_DEEP_BOOK_SQL}) "
        f"AND {intra_ms_expr} > ? "
        f"AND {intra_ms_expr} <= {close_intra_sql}",
        [str(path), last_continuous],
    ).fetchone()
    return int(row[0]) if row is not None and row[0] is not None else None
```

- [ ] **Step 2: Write integrated bundle tests**

Add a test in `tests/hoga/api/test_bundle.py` near the volume distribution tests. Use existing local helpers in that file for writing parquet if available; otherwise create minimal `trades.parquet`, `snapshots.parquet`, `candles.parquet`, and `meta.json` fixtures matching neighboring tests.

The assertion must prove this behavior:

```python
def test_range_volume_distribution_uses_first_single_price_book_cutoff(tmp_path: Path) -> None:
    """A side=1 trade after the final deep orderbook is closing-auction tail and excluded."""
    # Arrange one normal 10-level snapshot at 15:19:59.
    # Arrange one shallow 3-level snapshot at 15:20:01.
    # Arrange a small side=1 trade at 15:19:59 and a huge side=1 trade at 15:20:01.
    # Request volume_distribution_bins.
    # Assert the huge 15:20:01 trade is not present in the returned bins.
```

If the file already has fixture writers, use those exact helpers. The important numbers:

```python
session_open_ms = 90_000_000
session_close_ms = 153_000_000
last_continuous_snapshot = 151_959_000
auction_tail_trade = 152_001_000
```

- [ ] **Step 3: Run test to verify failure**

Run:

```bash
uv run --extra dev pytest tests/hoga/api/test_bundle.py -k "volume_distribution_uses_first_single_price" -q
```

Expected: FAIL because the 15:20:01 side=1 trade is still counted.

- [ ] **Step 4: Wire cutoff through bundle**

In `hoga/api/bundle.py`, add a helper near the indicator slice builders:

```python
def _first_trailing_single_price_book_hhmmssms(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str,
    session_close_ms: int,
) -> int | None:
    snapshots_path = engine.parquet_dir(date, code, source) / "snapshots.parquet"
    if not snapshots_path.exists():
        return None
    intra_ms = snapshots_tbl.query_first_trailing_single_price_book_intra_ms(
        engine.conn,
        path=snapshots_path,
        session_close_ms=session_close_ms,
    )
    if intra_ms is None:
        return None
    h = intra_ms // 3_600_000
    m = (intra_ms // 60_000) % 60
    s = (intra_ms // 1000) % 60
    ms = intra_ms % 1000
    return h * 10_000_000 + m * 100_000 + s * 1000 + ms
```

Inside the per-date loop in `build_range_bundle`, compute this once after `norm_meta`:

```python
continuous_before_ms = _first_trailing_single_price_book_hhmmssms(
    engine,
    code=code,
    date=d,
    source=source,
    session_close_ms=int(meta["regular_session_close_ms"]),
)
```

Pass it into both trade aggregations:

```python
tvp_d = None if hoga_only else build_trade_volume_poc_slice(
    engine, code=code, date=d, source=trade_indicator_source,
    session_open_ms=norm_meta["regular_session_open_ms"],
    session_close_ms=meta["regular_session_close_ms"],
    continuous_before_ms=continuous_before_ms,
    range_count=trade_volume_poc_bins or DEFAULT_TRADE_VOLUME_POC_BINS,
    price_range=price_range,
    cache=indicators_cache,
    today_kst=today_kst,
)
```

Update `build_trade_volume_poc_slice` and `build_volume_distribution_slice` signatures to accept `continuous_before_ms: int | None = None`, then pass it to the `trades_tbl` query functions.

- [ ] **Step 5: Run integrated tests**

Run:

```bash
uv run --extra dev pytest tests/hoga/api/test_bundle.py -k "volume_distribution or trade_volume_poc" -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/tables/snapshots.py hoga/api/bundle.py tests/hoga/api/test_bundle.py
git commit -m "feat: derive trade volume cutoff from orderbook structure"
```

---

### Task 3: Frontend Live Distribution Uses Live Orderbook Cutoff

**Files:**
- Modify: `frontend/src/live/continuousTradeVolumeDistribution.ts`
- Modify: `frontend/src/live/LiveSidebar.tsx`
- Test: `frontend/src/live/continuousTradeVolumeDistribution.test.ts`

**Interfaces:**
- Consumes: `ObSnapshot` from `frontend/src/live/bucketHogaSeries.ts`.
- Produces:
  - `firstTrailingSinglePriceBookMs(ob: readonly ObSnapshot[], sessionCloseMs: number): number | null`
  - `continuousBeforeMs?: number | null` parameter on live distribution functions.

- [ ] **Step 1: Write failing frontend tests**

Add to `frontend/src/live/continuousTradeVolumeDistribution.test.ts`:

```ts
it('excludes live trades at and after the first trailing single-price orderbook snapshot', () => {
  const profile = computeContinuousTradeVolumeDistribution({
    date: '20260625',
    candles: [{ ts_ms: 1, open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
    trades: [
      { t_ms: 90_000_000, price: 100, qty: 10, side: 1 },
      { t_ms: 152_001_000, price: 110, qty: 999, side: 1 },
    ],
    rangeCount: 2,
    segment: { date: '20260625', session_open_ms: 90_000_000, session_close_ms: 153_000_000 },
    continuousBeforeMs: 152_001_000,
  });

  expect(profile?.bins.map((bin) => bin.qty)).toEqual([10, 0]);
});

it('merges only newer live trades before the continuous cutoff', () => {
  const selected = selectVolumeDistributionProfile({
    enabled: true,
    date: '20260625',
    todayKst: '20260625',
    rangeCount: 2,
    persistedProfiles: [profile({ last_trade_ms: 90_001_000 })],
    recomputedToday: null,
    liveTrades: [
      { t_ms: 90_002_000, price: 105, qty: 7, side: 1 },
      { t_ms: 152_001_000, price: 115, qty: 999, side: 1 },
    ],
    continuousBeforeMs: 152_001_000,
  });

  expect(selected?.bins.map((bin) => bin.qty)).toEqual([17, 20]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd frontend && npm test -- --run src/live/continuousTradeVolumeDistribution.test.ts
```

Expected: FAIL because `continuousBeforeMs` is not part of the function arguments yet.

- [ ] **Step 3: Implement frontend cutoff support**

In `frontend/src/live/continuousTradeVolumeDistribution.ts`, import `isContinuousBook` and type `ObSnapshot`:

```ts
import { isContinuousBook, type ObSnapshot } from './bucketHogaSeries';
```

Add:

```ts
export function firstTrailingSinglePriceBookMs(
  snapshots: readonly ObSnapshot[],
  sessionCloseMs: number,
): number | null {
  let lastContinuous: number | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.t_ms <= sessionCloseMs && isContinuousBook(snapshot)) {
      lastContinuous =
        lastContinuous == null ? snapshot.t_ms : Math.max(lastContinuous, snapshot.t_ms);
    }
  }
  if (lastContinuous == null) return null;

  let firstSinglePrice: number | null = null;
  for (const snapshot of snapshots) {
    if (
      snapshot.t_ms > lastContinuous &&
      snapshot.t_ms <= sessionCloseMs &&
      !isContinuousBook(snapshot)
    ) {
      firstSinglePrice =
        firstSinglePrice == null ? snapshot.t_ms : Math.min(firstSinglePrice, snapshot.t_ms);
    }
  }
  return firstSinglePrice;
}

function tradeWithinContinuousCutoff(
  tMs: number,
  sessionCloseMs: number,
  continuousBeforeMs?: number | null,
): boolean {
  const upper = continuousBeforeMs ?? sessionCloseMs;
  return tMs < upper;
}
```

Update `mergeVolumeDistributionDelta`, `selectVolumeDistributionProfile`, and `computeContinuousTradeVolumeDistribution` argument types to include:

```ts
continuousBeforeMs?: number | null;
```

Then add the cutoff checks:

```ts
if (!tradeWithinContinuousCutoff(trade.t_ms, profile.session_close_ms, continuousBeforeMs)) continue;
```

and:

```ts
if (!tradeWithinContinuousCutoff(trade.t_ms, segment.session_close_ms, args.continuousBeforeMs)) continue;
```

- [ ] **Step 4: Wire LiveSidebar**

In `frontend/src/live/LiveSidebar.tsx`, import `firstTrailingSinglePriceBookMs` from `continuousTradeVolumeDistribution`.

Compute after `todaySegment` exists:

```ts
const todayContinuousBeforeMs = useMemo(() => {
  if (!activeBundle || !todayKst) return null;
  const todaySegment = activeBundle.segments.find((segment) => segment.date === todayKst);
  if (!todaySegment) return null;
  return firstTrailingSinglePriceBookMs(ob, todaySegment.session_close_ms);
}, [activeBundle, todayKst, ob]);
```

Pass `continuousBeforeMs: todayContinuousBeforeMs` into both `computeContinuousTradeVolumeDistribution` and `selectVolumeDistributionProfile`.

- [ ] **Step 5: Run frontend tests**

Run:

```bash
cd frontend && npm test -- --run src/live/continuousTradeVolumeDistribution.test.ts src/live/LiveSidebar.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/continuousTradeVolumeDistribution.ts frontend/src/live/LiveSidebar.tsx frontend/src/live/continuousTradeVolumeDistribution.test.ts
git commit -m "feat: exclude closing auction tail from live volume distribution"
```

---

### Task 4: Final Verification

**Files:**
- No new files.

**Interfaces:**
- Verifies Tasks 1-3 together.

- [ ] **Step 1: Run backend targeted suite**

Run:

```bash
uv run --extra dev pytest tests/test_tables_trades.py tests/hoga/api/test_bundle.py -k "volume_distribution or trade_volume_poc or continuous_before" -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend targeted suite**

Run:

```bash
cd frontend && npm test -- --run \
  src/live/continuousTradeVolumeDistribution.test.ts \
  src/live/tradeVolumePoc.test.ts \
  src/live/useTradeVolumePoc.test.tsx \
  src/live/bucketHogaSeries.test.ts \
  src/chart/projectors/quoteTotals.test.ts
```

Expected: PASS.

- [ ] **Step 3: Inspect diff for policy drift**

Run:

```bash
git diff -- hoga/tables/trades.py hoga/tables/snapshots.py hoga/api/bundle.py frontend/src/live/continuousTradeVolumeDistribution.ts frontend/src/live/LiveSidebar.tsx
```

Confirm:

```text
No fixed 15:20 literal was introduced.
No session_close_ms - 10min cutoff was introduced for volume distribution.
No phase === "regular" filter was introduced for volume distribution.
side ±1 filters remain.
Fallback without snapshots preserves existing session-close behavior.
```

- [ ] **Step 4: Commit verification notes if tests or docs changed**

Only if additional docs or test fixtures changed:

```bash
git add <changed-files>
git commit -m "test: verify closing auction cutoff for volume distribution"
```

---

## Self-Review

**Spec coverage:** The plan implements structural closing-auction exclusion for past parquet and live delta. It explicitly avoids fixed time, `session_close - 10min`, and `phase === "regular"`. It keeps intraday VI in scope by using only the trailing single-price run after the final continuous book before close, not per-trade local VI filtering.

**Placeholder scan:** No TBD/TODO placeholders. Integrated bundle fixture details may need adaptation to existing helpers, but the expected data and assertions are fully specified.

**Type consistency:** Backend uses HHMMSSmmm for `continuous_before_ms` in table queries and converts from intra-ms in bundle. Frontend uses Unix ms for `continuousBeforeMs`, matching `segment.session_close_ms` and live orderbook `t_ms`. The cutoff is exclusive: include `trade.t_ms < continuousBeforeMs`.
