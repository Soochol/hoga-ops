# Peak Wall Lifecycle Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank peak wall overlays by wall lifecycle, where a lifecycle is one price segment bounded by later touch trades, so same-price pre-touch repeats collapse to the largest wall and same-price post-touch walls start fresh candidates.

**Architecture:** Keep the current API payload shape (`traded_peaks`, `untraded_peaks`, max variants) but change the backend query to emit lifecycle representatives instead of raw top events. Frontend same-price de-dupe remains a visual guard, not the source of ranking truth.

**Tech Stack:** Python 3.14, DuckDB SQL over parquet, pytest, existing React/TypeScript overlay consumers.

## Global Constraints

- Do not change API field names or TypeScript wire types.
- Preserve ask/bid symmetry: ask touch is `trade.price >= wall.price`; bid touch is `trade.price <= wall.price`.
- Preserve ranking order: `qty DESC, intra_ms ASC, seq ASC, price ASC`.
- Return up to 3 lifecycle candidates per family: traded, untraded, traded_max, untraded_max.
- Same price may appear in both traded and untraded families when separated by a touch.
- Same price must not consume multiple ranks inside one uninterrupted lifecycle.
- Keep edits scoped to `hoga/tables/snapshots.py` and `tests/test_tables_snapshots.py`.

---

## File Structure

- Modify `hoga/tables/snapshots.py`
  - Responsibility: build lifecycle-aware ranked peak candidates in `query_day_ask_bid_peak_dual`.
  - Keep existing row models and return shape.

- Modify `tests/test_tables_snapshots.py`
  - Responsibility: prove backend ranking semantics before frontend rendering.
  - Add focused ask and bid lifecycle tests near existing event-based peak tests.

---

### Task 1: Add Backend Regression Tests For Same-Price Lifecycle Ranking

**Files:**
- Modify: `tests/test_tables_snapshots.py`

**Interfaces:**
- Consumes: `query_day_ask_peak_dual`, `query_day_bid_peak_dual`, `_ob_ap`, `_ob_bp`, `_trade`, `write_parquet`, `write_trades`, `AskPeakCandidateRow`.
- Produces: failing tests that define lifecycle ranking for backend candidate arrays.

- [ ] **Step 1: Add ask lifecycle regression test**

Add this test after `test_query_day_ask_peak_dual_classifies_post_touch_and_post_untouched_events`:

```python
def test_query_day_ask_peak_dual_ranks_lifecycle_representatives_not_raw_repeats(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_ap(
                100000000,
                [5000, 4000, 3000, 1, 1, 1, 1, 1, 1, 1],
                ask_p=[50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900],
                seq=1,
            ),
            _ob_ap(
                100100000,
                [8000, 4100, 3100, 1, 1, 1, 1, 1, 1, 1],
                ask_p=[50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900],
                seq=2,
            ),
            _ob_ap(
                100200000,
                [7000, 4200, 3200, 1, 1, 1, 1, 1, 1, 1],
                ask_p=[50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900],
                seq=3,
            ),
            _ob_ap(
                100400000,
                [9000, 4300, 3300, 1, 1, 1, 1, 1, 1, 1],
                ask_p=[50000, 50100, 50200, 50300, 50400, 50500, 50600, 50700, 50800, 50900],
                seq=4,
            ),
        ],
        snapshots_path,
    )
    write_trades([
        _trade(100300000, 50000, side=1, seq=10),
    ], trades_path)

    peak = query_day_ask_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks == (
        AskPeakCandidateRow(price=50000, qty=8000, intra_ms=36_060_000),
        AskPeakCandidateRow(price=50100, qty=4200, intra_ms=36_120_000),
        AskPeakCandidateRow(price=50200, qty=3200, intra_ms=36_120_000),
    )
    assert peak.untraded_peaks[0] == AskPeakCandidateRow(price=50000, qty=9000, intra_ms=36_240_000)
```

- [ ] **Step 2: Add bid lifecycle regression test**

Add this test after `test_query_day_bid_peak_dual_classifies_post_touch_and_post_untouched_events`:

```python
def test_query_day_bid_peak_dual_ranks_lifecycle_representatives_not_raw_repeats(tmp_path: Path) -> None:
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(
        [
            _ob_bp(
                100000000,
                [5000, 4000, 3000, 1, 1, 1, 1, 1, 1, 1],
                bid_p=[50000, 49900, 49800, 49700, 49600, 49500, 49400, 49300, 49200, 49100],
                seq=1,
            ),
            _ob_bp(
                100100000,
                [8000, 4100, 3100, 1, 1, 1, 1, 1, 1, 1],
                bid_p=[50000, 49900, 49800, 49700, 49600, 49500, 49400, 49300, 49200, 49100],
                seq=2,
            ),
            _ob_bp(
                100200000,
                [7000, 4200, 3200, 1, 1, 1, 1, 1, 1, 1],
                bid_p=[50000, 49900, 49800, 49700, 49600, 49500, 49400, 49300, 49200, 49100],
                seq=3,
            ),
            _ob_bp(
                100400000,
                [9000, 4300, 3300, 1, 1, 1, 1, 1, 1, 1],
                bid_p=[50000, 49900, 49800, 49700, 49600, 49500, 49400, 49300, 49200, 49100],
                seq=4,
            ),
        ],
        snapshots_path,
    )
    write_trades([
        _trade(100300000, 50000, side=-1, seq=10),
    ], trades_path)

    peak = query_day_bid_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert peak is not None
    assert peak.traded_peaks == (
        AskPeakCandidateRow(price=50000, qty=8000, intra_ms=36_060_000),
        AskPeakCandidateRow(price=49900, qty=4200, intra_ms=36_120_000),
        AskPeakCandidateRow(price=49800, qty=3200, intra_ms=36_120_000),
    )
    assert peak.untraded_peaks[0] == AskPeakCandidateRow(price=50000, qty=9000, intra_ms=36_240_000)
```

- [ ] **Step 3: Run ask test and verify it fails**

Run:

```bash
uv run pytest tests/test_tables_snapshots.py::test_query_day_ask_peak_dual_ranks_lifecycle_representatives_not_raw_repeats -q
```

Expected: FAIL because `traded_peaks` contains repeated `price=50000` raw events instead of one lifecycle representative plus other prices.

- [ ] **Step 4: Run bid test and verify it fails**

Run:

```bash
uv run pytest tests/test_tables_snapshots.py::test_query_day_bid_peak_dual_ranks_lifecycle_representatives_not_raw_repeats -q
```

Expected: FAIL because `traded_peaks` contains repeated `price=50000` raw events instead of one lifecycle representative plus other prices.

- [ ] **Step 5: Commit failing tests only if using checkpoint workflow**

```bash
git add tests/test_tables_snapshots.py
git commit -m "test: cover lifecycle peak wall ranking"
```

---

### Task 2: Build Lifecycle Representatives In The Backend Query

**Files:**
- Modify: `hoga/tables/snapshots.py`

**Interfaces:**
- Consumes: existing CTEs `{side}_rep_classified` and `{side}_cont_classified` with `ts_ms`, `seq`, `price`, `qty`, `intra_ms`, `bucket_id`, `is_touched`.
- Produces: lifecycle CTEs named `{side}_rep_lifecycle` and `{side}_cont_lifecycle`, used by ranked arrays and scalar peak fields.

- [ ] **Step 1: Replace raw ranked CTE inputs with lifecycle CTEs**

Inside `scalar_and_array_ctes(side)`, add lifecycle representative CTEs before `{side}_all_close`:

```python
        {side}_rep_touch_stream AS (
          SELECT ts_ms, seq, price
          FROM touch_ticks
        ),
        {side}_rep_lifecycle_events AS (
          SELECT c.*,
                 (
                   SELECT COUNT(*)
                   FROM {side}_rep_touch_stream t
                   WHERE t.price {" >= " if side == "ask" else " <= "} c.price
                     AND (t.ts_ms < c.ts_ms OR (t.ts_ms = c.ts_ms AND t.seq < c.seq))
                 ) AS lifecycle_id
          FROM {side}_rep_classified c
        ),
        {side}_rep_lifecycle_ranked AS (
          SELECT price, qty, intra_ms, seq, bucket_id, is_touched, lifecycle_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY price, lifecycle_id
                   ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                 ) AS lifecycle_rn
          FROM {side}_rep_lifecycle_events
        ),
        {side}_rep_lifecycle AS (
          SELECT price, qty, intra_ms, seq, bucket_id, is_touched
          FROM {side}_rep_lifecycle_ranked
          WHERE lifecycle_rn = 1
        ),
        {side}_cont_touch_stream AS (
          SELECT ts_ms, seq, price
          FROM touch_ticks
        ),
        {side}_cont_lifecycle_events AS (
          SELECT c.*,
                 (
                   SELECT COUNT(*)
                   FROM {side}_cont_touch_stream t
                   WHERE t.price {" >= " if side == "ask" else " <= "} c.price
                     AND (t.ts_ms < c.ts_ms OR (t.ts_ms = c.ts_ms AND t.seq < c.seq))
                 ) AS lifecycle_id
          FROM {side}_cont_classified c
        ),
        {side}_cont_lifecycle_ranked AS (
          SELECT price, qty, intra_ms, seq, bucket_id, is_touched, lifecycle_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY price, lifecycle_id
                   ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                 ) AS lifecycle_rn
          FROM {side}_cont_lifecycle_events
        ),
        {side}_cont_lifecycle AS (
          SELECT price, qty, intra_ms, seq, bucket_id, is_touched
          FROM {side}_cont_lifecycle_ranked
          WHERE lifecycle_rn = 1
        ),
```

Important: implement this as an f-string-safe block, not by pasting invalid nested Python expressions. Define:

```python
lifecycle_comparator = ">=" if side == "ask" else "<="
```

Then use `t.price {lifecycle_comparator} c.price` in the SQL string.

- [ ] **Step 2: Point scalar CTEs at lifecycle representatives**

In `scalar_and_array_ctes(side)`, change these sources:

```sql
FROM {side}_rep_classified
FROM {side}_cont_classified
```

to these sources for all scalar CTEs:

```sql
FROM {side}_rep_lifecycle
FROM {side}_cont_lifecycle
```

Affected scalar CTEs:

```text
{side}_all_close
{side}_all_max
{side}_traded_close
{side}_traded_max
{side}_untraded_close
{side}_untraded_max
```

- [ ] **Step 3: Point ranked CTEs at lifecycle representatives**

Change ranked arrays to use lifecycle sources:

```sql
FROM {side}_rep_lifecycle
WHERE is_touched
```

```sql
FROM {side}_cont_lifecycle
WHERE is_touched
```

```sql
FROM {side}_rep_lifecycle
WHERE NOT is_touched
```

```sql
FROM {side}_cont_lifecycle
WHERE NOT is_touched
```

Affected arrays:

```text
{side}_traded_peaks
{side}_traded_max_peaks
{side}_untraded_peaks
{side}_untraded_max_peaks
```

- [ ] **Step 4: Keep all-peaks behavior explicit**

Change all-price candidate source to lifecycle sources so `all_peaks` also represents walls, not repeated raw timestamps:

```sql
FROM {side}_rep_lifecycle
```

and:

```sql
FROM {side}_cont_lifecycle
```

Do not remove the existing `PARTITION BY price, bucket_id` unless tests prove it conflicts with lifecycle ranking. It keeps old all-peaks bucket behavior stable.

- [ ] **Step 5: Run failing tests and verify they pass**

Run:

```bash
uv run pytest \
  tests/test_tables_snapshots.py::test_query_day_ask_peak_dual_ranks_lifecycle_representatives_not_raw_repeats \
  tests/test_tables_snapshots.py::test_query_day_bid_peak_dual_ranks_lifecycle_representatives_not_raw_repeats \
  -q
```

Expected: PASS.

- [ ] **Step 6: Run existing peak event tests**

Run:

```bash
uv run pytest tests/test_tables_snapshots.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit backend lifecycle implementation**

```bash
git add hoga/tables/snapshots.py tests/test_tables_snapshots.py
git commit -m "fix(api): rank peak walls by lifecycle"
```

---

### Task 3: Verify Real SKT Data And API Payload

**Files:**
- No code changes.

**Interfaces:**
- Consumes: `QueryEngine`, `build_range_bundle`, SKT local parquet for `017670` on `20260422`.
- Produces: evidence that backend returns up to 3 lifecycle candidates per family and keeps same-price post-touch/new-wall split.

- [ ] **Step 1: Run direct parquet query**

Run:

```bash
uv run python - <<'PY'
from pathlib import Path
import duckdb
from hoga.tables.snapshots import query_day_ask_bid_peak_dual

base = Path('/home/dev/.local/share/hoga-ops/data/parquet/20260422/017670/hogaplay')
ask, bid = query_day_ask_bid_peak_dual(
    duckdb.connect(),
    path=base / 'snapshots.parquet',
    trades_path=base / 'trades.parquet',
    bucket_ms=60_000,
    session_open_ms=90_000_000,
    session_close_ms=153_000_000,
)
for name, rows in [
    ('ask.traded', ask.traded_peaks),
    ('ask.untraded', ask.untraded_peaks),
    ('bid.traded', bid.traded_peaks),
    ('bid.untraded', bid.untraded_peaks),
]:
    print(name, len(rows), [(r.price, r.qty, r.intra_ms) for r in rows])
PY
```

Expected:
- Each printed family has at most 3 rows.
- Rows are lifecycle representatives.
- Same-price repeats before touch do not consume multiple ranks.

- [ ] **Step 2: Run API-side bundle check**

Run:

```bash
uv run python - <<'PY'
from pathlib import Path
from hoga.api.queries import QueryEngine
from hoga.api.bundle import build_range_bundle

engine = QueryEngine(Path('/home/dev/.local/share/hoga-ops/data'))
bundle = build_range_bundle(
    engine,
    code='017670',
    from_date='20260422',
    to_date='20260422',
    bucket_ms=60_000,
    source_pref='hogaplay',
    mode='sidecar',
)
ask = bundle.ask_peaks[0]
bid = bundle.bid_peaks[0]
print('ask.traded', [(p.price, p.qty, p.t_ms) for p in ask.traded_peaks])
print('ask.untraded', [(p.price, p.qty, p.t_ms) for p in ask.untraded_peaks])
print('bid.traded', [(p.price, p.qty, p.t_ms) for p in bid.traded_peaks])
print('bid.untraded', [(p.price, p.qty, p.t_ms) for p in bid.untraded_peaks])
PY
```

Expected:
- `ask.traded_peaks` and `ask.untraded_peaks` are both populated when the date has both families.
- Candidate arrays are lifecycle-ranked, not raw duplicate timestamps.

- [ ] **Step 3: Commit verification notes only if a doc update is requested**

No commit is required for this task unless the user asks for a written debug report.

---

### Task 4: Frontend Guardrail Tests For Six Visible Segments

**Files:**
- Modify: `frontend/src/live/LiveAskPeakSegments.test.tsx`
- Modify: `frontend/src/live/LiveBidPeakSegments.test.tsx`

**Interfaces:**
- Consumes: existing `buildAskPeakOverlaySegments` and `buildBidPeakOverlaySegments`.
- Produces: tests proving backend lifecycle arrays with 3 traded + 3 untraded render 6 segments when prices/lifecycles are distinct.

- [ ] **Step 1: Add ask render-count test**

Add a test to `frontend/src/live/LiveAskPeakSegments.test.tsx`:

```ts
it('renders three traded and three untraded ask lifecycle walls', () => {
  const day = '20260613';
  const base = peak({ date: day, price: 100, qty: 900, t_ms: 60_000 });
  const out = buildAskPeakOverlaySegments({
    dayAskPeaks: [{
      ...base,
      traded_peaks: [
        { price: 100, qty: 900, t_ms: 60_000 },
        { price: 101, qty: 800, t_ms: 120_000 },
        { price: 102, qty: 700, t_ms: 180_000 },
      ],
      traded_max_peaks: [
        { price: 100, qty: 900, t_ms: 60_000 },
        { price: 101, qty: 800, t_ms: 120_000 },
        { price: 102, qty: 700, t_ms: 180_000 },
      ],
      untraded_peaks: [
        { price: 103, qty: 950, t_ms: 240_000 },
        { price: 104, qty: 850, t_ms: 300_000 },
        { price: 105, qty: 750, t_ms: 360_000 },
      ],
      untraded_max_peaks: [
        { price: 103, qty: 950, t_ms: 240_000 },
        { price: 104, qty: 850, t_ms: 300_000 },
        { price: 105, qty: 750, t_ms: 360_000 },
      ],
    }],
    todayAllPriceAskPeak: null,
    segments: [seg(day, 0, 420_000)],
    candles: [candle(60_000), candle(120_000), candle(180_000), candle(240_000), candle(300_000), candle(360_000)],
    axis,
    todayKst: day,
    baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
    allPriceStyle: { color: '#F97316', lineWidth: 1 },
    intraMax: false,
    showAllPrices: true,
    allPriceRankLimit: 3,
    untradedRankLimit: 3,
  });

  expect(out).toHaveLength(6);
  expect(out.map((segment) => segment.price)).toEqual([100, 101, 102, 103, 104, 105]);
});
```

- [ ] **Step 2: Add bid render-count test**

Add the bid equivalent to `frontend/src/live/LiveBidPeakSegments.test.tsx`, using the file’s existing helpers:

```ts
it('renders three traded and three untraded bid lifecycle walls', () => {
  const day = '20260613';
  const open = Date.UTC(2026, 5, 13, 0, 0);
  const segments = buildBidPeakOverlaySegments({
    dayBidPeaks: [{
      date: day,
      price: 100,
      qty: 900,
      t_ms: open + 60_000,
      max_price: 100,
      max_qty: 900,
      max_t_ms: open + 60_000,
      traded_peaks: [
        { price: 100, qty: 900, t_ms: open + 60_000 },
        { price: 99, qty: 800, t_ms: open + 120_000 },
        { price: 98, qty: 700, t_ms: open + 180_000 },
      ],
      traded_max_peaks: [
        { price: 100, qty: 900, t_ms: open + 60_000 },
        { price: 99, qty: 800, t_ms: open + 120_000 },
        { price: 98, qty: 700, t_ms: open + 180_000 },
      ],
      untraded_peaks: [
        { price: 97, qty: 950, t_ms: open + 240_000 },
        { price: 96, qty: 850, t_ms: open + 300_000 },
        { price: 95, qty: 750, t_ms: open + 360_000 },
      ],
      untraded_max_peaks: [
        { price: 97, qty: 950, t_ms: open + 240_000 },
        { price: 96, qty: 850, t_ms: open + 300_000 },
        { price: 95, qty: 750, t_ms: open + 360_000 },
      ],
    }],
    todayAllPriceBidPeak: null,
    segments: [{ date: day, session_open_ms: open, session_close_ms: open + 420_000 }],
    candles: [
      { ts_ms: open + 60_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
      { ts_ms: open + 120_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
      { ts_ms: open + 180_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
      { ts_ms: open + 240_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
      { ts_ms: open + 300_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
      { ts_ms: open + 360_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
    ],
    axis: createVirtualAxis([{ date: day, sessionOpenMs: open, sessionCloseMs: open + 420_000 }], open),
    todayKst: day,
    baselineStyle: { color: '#fff', lineWidth: 1 },
    allPriceStyle: { color: '#f00', lineWidth: 1 },
    intraMax: false,
    showAllPrices: true,
    allPriceRankLimit: 3,
    untradedRankLimit: 3,
  });

  expect(segments).toHaveLength(6);
  expect(segments.map((segment) => segment.price)).toEqual([100, 99, 98, 97, 96, 95]);
});
```

- [ ] **Step 3: Run frontend segment tests**

Run:

```bash
cd frontend && npm test -- LiveAskPeakSegments.test.tsx LiveBidPeakSegments.test.tsx --runInBand
```

If the test runner uses Vitest syntax in this repo, run:

```bash
cd frontend && npm run test -- LiveAskPeakSegments.test.tsx LiveBidPeakSegments.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Commit frontend guardrails**

```bash
git add frontend/src/live/LiveAskPeakSegments.test.tsx frontend/src/live/LiveBidPeakSegments.test.tsx
git commit -m "test(frontend): cover six peak wall lifecycle segments"
```

---

## Self-Review

**Spec coverage:** The plan covers same-price pre-touch collapse, post-touch same-price restart, traded/untraded families, ask/bid symmetry, backend payload, and frontend six-segment visibility.

**Placeholder scan:** No TBD, TODO, or unspecified commands remain.

**Type consistency:** The plan keeps existing `AskPeakCandidateRow`, `AskPeak`, `BidPeak`, `traded_peaks`, `untraded_peaks`, `traded_max_peaks`, and `untraded_max_peaks` names.

**Risk:** The lifecycle `COUNT(*)` subqueries may be slower than the suffix-window touch classifier on very large days. If Task 3 shows sidecar latency above 1 second for one stock-day, replace lifecycle id generation with a window-based touch ordinal in the same SQL pass before shipping.

