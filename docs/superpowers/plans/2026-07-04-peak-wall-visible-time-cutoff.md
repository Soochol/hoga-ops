# Peak Wall Visible Time Cutoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independent ask/bid `보이는 최신 봉 기준` toggles that recalculate daily peak-wall indicators from candidates known at or before the rightmost visible minute candle, on both `/live` and `/study`.

**Architecture:** Keep cutoff derivation in `LiveChartRoot` so `/live` and `/study` share one viewport basis. Keep candidate selection pure in peak-wall segment modules and feed it timestamped ranked candidates from the backend wire shape. Do not hide a full-day result after selection; filter candidates before choosing rendered peak lines.

**Tech Stack:** Python 3 + DuckDB/Pydantic/pytest backend; React 18 + TypeScript + Zustand + lightweight-charts + Vitest frontend.

## Global Constraints

- Defaults: `askPeakVisibleTimeCutoff=false`, `bidPeakVisibleTimeCutoff=false`.
- UI label: `보이는 최신 봉 기준`.
- Cutoff source: the rightmost visible minute candle's real `ts_ms`, not crosshair hover.
- Cutoff scope: baseline `체결가격 기준 최대벽`, optional `미체결 포함 최대벽`, and visible-area ranking/highlight candidates all share the same side-specific cutoff.
- Multi-date viewport: the rightmost visible candle's Stock-Date is the only cutoff date; earlier dates keep full-day values and later dates are omitted.
- Candidate fallback: if the cutoff date has no timestamped candidate at or before cutoff, omit that date's line; never silently show a full-day peak as cutoff-correct.
- Routes: `/live` and `/study` must behave the same because both render `LiveChartRoot`.
- No backend API calls on scroll/zoom.

---

## File Structure

- `hoga/tables/snapshots.py`: extend bid peak rows and shared ask/bid peak query to return bid `traded_peaks` and `traded_max_peaks`.
- `hoga/api/models.py`: mirror bid ranked candidate fields on `BidPeak`.
- `hoga/api/bundle.py`: convert bid candidate rows to unix-ms candidate dictionaries.
- `tests/test_tables_snapshots.py`: verify bid ranked candidates from snapshot/trade parquet.
- `tests/hoga/api/test_bundle.py`: verify bid ranked candidates survive bundle model conversion.
- `frontend/src/api/types.ts`: mirror bid candidate arrays in TypeScript.
- `frontend/src/state/chartPrefs.ts`: add two `indicator-modal` cutoff toggles.
- `frontend/src/state/chartPrefs.test.ts`: verify default/persistence/category behavior and ask/bid independence.
- `frontend/src/live/indicators/AskPeakConfig.tsx`: render ask cutoff toggle row.
- `frontend/src/live/indicators/BidPeakConfig.tsx`: render bid cutoff toggle row.
- `frontend/src/live/indicators/IndicatorPanel.test.tsx`: verify the new rows appear in both detail panes.
- `frontend/src/live/peakWallVisibleCutoff.ts`: new pure helpers for deriving visible cutoff and filtering candidate families.
- `frontend/src/live/peakWallVisibleCutoff.test.ts`: unit tests for multi-date and no-candidate rules.
- `frontend/src/live/LiveAskPeakSegments.tsx`: apply cutoff before ask baseline/untraded/visible-rank segment creation.
- `frontend/src/live/LiveBidPeakSegments.tsx`: apply cutoff before bid baseline/untraded segment creation.
- `frontend/src/live/LiveChartRoot.tsx`: read toggles, derive visible cutoff, pass side-specific cutoff into ask/bid overlay builders and high/low label avoidance.
- `frontend/src/live/LiveChartRoot.test.tsx`: verify right-edge visible range updates propagate to the cutoff helpers through rendered overlays.

---

### Task 1: Add Bid Ranked Candidates To Backend Wire

**Files:**
- Modify: `hoga/tables/snapshots.py`
- Modify: `hoga/api/models.py`
- Modify: `hoga/api/bundle.py`
- Modify: `frontend/src/api/types.ts`
- Test: `tests/test_tables_snapshots.py`
- Test: `tests/hoga/api/test_bundle.py`
- Test: `tests/test_api_ask_peak_model.py`

**Interfaces:**
- Consumes: existing `AskPeakCandidateRow`, `AskPeakDualRow.traded_peaks`, `_ask_candidate(date, c)`.
- Produces: `BidPeakDualRow.traded_peaks: tuple[AskPeakCandidateRow, ...]`, `BidPeakDualRow.traded_max_peaks: tuple[AskPeakCandidateRow, ...]`, Python/TS `BidPeak.traded_peaks`, `BidPeak.traded_max_peaks`.

- [ ] **Step 1: Write failing snapshot-table test for bid candidates**

Append this test to `tests/test_tables_snapshots.py` near `test_query_day_ask_peak_dual_returns_top_three_traded_price_peaks`:

```python
def test_query_day_ask_bid_peak_dual_returns_top_three_bid_traded_price_peaks(tmp_path) -> None:
    """과거일 매수 최대벽도 가격별 best를 수량순 3등까지 반환한다."""
    obs = [
        _ob_bp(
            90100000,
            [1000, 9000, 7000, 6000, 500, 6, 7, 8, 9, 1],
            bid_p=[25000, 24900, 24800, 24700, 24600, 24500, 24400, 24300, 24200, 24100],
        ),
        _ob_bp(
            90200000,
            [3000, 8000, 7100, 100, 500, 6, 7, 8, 9, 1],
            bid_p=[25000, 24900, 24800, 24700, 24600, 24500, 24400, 24300, 24200, 24100],
        ),
    ]
    snapshots_path = tmp_path / "snapshots.parquet"
    trades_path = tmp_path / "trades.parquet"
    write_parquet(obs, snapshots_path)
    write_trades([
        _trade(90050000, 25000),
        _trade(90060000, 24900),
        _trade(90070000, 24800),
        _trade(90080000, 24700),
    ], trades_path)

    _ask, bid = query_day_ask_bid_peak_dual(
        _con_for(snapshots_path),
        path=snapshots_path,
        trades_path=trades_path,
        bucket_ms=60_000,
        session_open_ms=90000000,
        session_close_ms=153000000,
    )

    assert bid is not None
    assert bid.traded_peaks == (
        AskPeakCandidateRow(price=24900, qty=9000, intra_ms=32460000),
        AskPeakCandidateRow(price=24800, qty=7100, intra_ms=32520000),
        AskPeakCandidateRow(price=24700, qty=6000, intra_ms=32460000),
    )
    assert bid.traded_max_peaks == (
        AskPeakCandidateRow(price=24900, qty=9000, intra_ms=32460000),
        AskPeakCandidateRow(price=24800, qty=7100, intra_ms=32520000),
        AskPeakCandidateRow(price=24700, qty=6000, intra_ms=32460000),
    )
```

If `_ob_bp` does not exist in this file, add this helper beside `_ob_ap`:

```python
def _ob_bp(ts_ms: int, bid_q: list[int], *, bid_p: list[int]) -> Orderbook:
    z = tuple([0] * 10)
    ask_p = tuple(30000 + 10 * i for i in range(10))
    ask_q = tuple([100] * 10)
    return Orderbook(
        ts_ms=ts_ms,
        seq=ts_ms,
        ask_p=ask_p,
        ask_q=ask_q,
        ask_d=z,
        bid_p=tuple(bid_p),
        bid_q=tuple(bid_q),
        bid_d=z,
        tot_ask=sum(ask_q),
        tot_ask_d=0,
        tot_bid=sum(bid_q),
        tot_bid_d=0,
    )
```

- [ ] **Step 2: Run snapshot test and verify failure**

Run: `pytest tests/test_tables_snapshots.py::test_query_day_ask_bid_peak_dual_returns_top_three_bid_traded_price_peaks -q`

Expected: FAIL with an `AttributeError` for `BidPeakDualRow.traded_peaks` or an assertion failure showing empty/missing bid candidate tuples.

- [ ] **Step 3: Extend backend row/model/wire types**

In `hoga/tables/snapshots.py`, add candidate fields to `BidPeakDualRow`:

```python
@dataclass(frozen=True)
class BidPeakDualRow:
    price: int
    qty: int
    intra_ms: int
    max_price: int
    max_qty: int
    max_intra_ms: int
    traded_peaks: tuple[AskPeakCandidateRow, ...]
    traded_max_peaks: tuple[AskPeakCandidateRow, ...]
    all_price: int
    all_qty: int
    all_intra_ms: int
    all_max_price: int
    all_max_qty: int
    all_max_intra_ms: int
    untraded_price: int | None = None
    untraded_qty: int | None = None
    untraded_intra_ms: int | None = None
    untraded_max_price: int | None = None
    untraded_max_qty: int | None = None
    untraded_max_intra_ms: int | None = None
```

In `hoga/api/models.py`, extend `BidPeak`:

```python
class BidPeak(BaseModel):
    date: str
    price: int
    qty: int
    t_ms: int
    max_price: int
    max_qty: int
    max_t_ms: int
    all_price: int | None = None
    all_qty: int | None = None
    all_t_ms: int | None = None
    all_max_price: int | None = None
    all_max_qty: int | None = None
    all_max_t_ms: int | None = None
    untraded_price: int | None = None
    untraded_qty: int | None = None
    untraded_t_ms: int | None = None
    untraded_max_price: int | None = None
    untraded_max_qty: int | None = None
    untraded_max_t_ms: int | None = None
    traded_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    traded_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)
```

In `frontend/src/api/types.ts`, change the bid type:

```ts
/** hoga/api/models.py::BidPeak mirror. Candidate arrays mirror ask for cutoff/ranking. */
export type BidPeak = PeakBase & {
  traded_peaks?: AskPeakCandidate[];
  traded_max_peaks?: AskPeakCandidate[];
};
```

- [ ] **Step 4: Extend shared ask/bid query to return bid candidates**

In `query_day_ask_bid_peak_dual`, add bid candidate CTEs before the final `SELECT`:

```sql
        bid_traded_peak_candidates AS (
          SELECT price, qty, intra_ms,
                 ROW_NUMBER() OVER (
                   PARTITION BY price
                   ORDER BY qty DESC, intra_ms ASC
                 ) AS price_rn
          FROM bid_rep_levels
          WHERE price IN (SELECT price FROM traded_prices)
        ),
        bid_traded_peaks AS (
          SELECT 'bid_traded_peak' AS kind, price, qty, intra_ms,
                 ROW_NUMBER() OVER (ORDER BY qty DESC, intra_ms ASC) AS ord
          FROM bid_traded_peak_candidates
          WHERE price_rn = 1
          QUALIFY ord <= 3
        ),
        bid_traded_max_candidates AS (
          SELECT price, qty, intra_ms,
                 ROW_NUMBER() OVER (
                   PARTITION BY price
                   ORDER BY qty DESC, intra_ms ASC
                 ) AS price_rn
          FROM bid_cont_levels
          WHERE price IN (SELECT price FROM traded_prices)
        ),
        bid_traded_max_peaks AS (
          SELECT 'bid_traded_max_peak' AS kind, price, qty, intra_ms,
                 ROW_NUMBER() OVER (ORDER BY qty DESC, intra_ms ASC) AS ord
          FROM bid_traded_max_candidates
          WHERE price_rn = 1
          QUALIFY ord <= 3
        )
```

Then include them in the final union:

```sql
        UNION ALL SELECT * FROM bid_traded_peaks
        UNION ALL SELECT * FROM bid_traded_max_peaks
```

Update the `many` map:

```python
many: dict[str, list[AskPeakCandidateRow]] = {
    "ask_traded_peak": [],
    "ask_traded_max_peak": [],
    "bid_traded_peak": [],
    "bid_traded_max_peak": [],
}
```

Before constructing `BidPeakDualRow`, derive fallback candidate tuples:

```python
bid_traded_peaks = tuple(many["bid_traded_peak"])
bid_traded_max_peaks = tuple(many["bid_traded_max_peak"])
if not bid_traded_peaks:
    bid_traded_peaks = (AskPeakCandidateRow(price=bid_all_close[0], qty=bid_all_close[1], intra_ms=bid_all_close[2]),)
if not bid_traded_max_peaks:
    bid_traded_max_peaks = (AskPeakCandidateRow(price=bid_all_max[0], qty=bid_all_max[1], intra_ms=bid_all_max[2]),)
```

Pass them into the row:

```python
bid_row = BidPeakDualRow(
    price=bid_traded_close[0],
    qty=bid_traded_close[1],
    intra_ms=bid_traded_close[2],
    max_price=bid_traded_max[0],
    max_qty=bid_traded_max[1],
    max_intra_ms=bid_traded_max[2],
    traded_peaks=bid_traded_peaks,
    traded_max_peaks=bid_traded_max_peaks,
    all_price=bid_all_close[0],
    all_qty=bid_all_close[1],
    all_intra_ms=bid_all_close[2],
    all_max_price=bid_all_max[0],
    all_max_qty=bid_all_max[1],
    all_max_intra_ms=bid_all_max[2],
    untraded_price=bid_untraded_close[0] if bid_untraded_close is not None else None,
    untraded_qty=bid_untraded_close[1] if bid_untraded_close is not None else None,
    untraded_intra_ms=bid_untraded_close[2] if bid_untraded_close is not None else None,
    untraded_max_price=bid_untraded_max[0] if bid_untraded_max is not None else None,
    untraded_max_qty=bid_untraded_max[1] if bid_untraded_max is not None else None,
    untraded_max_intra_ms=bid_untraded_max[2] if bid_untraded_max is not None else None,
)
```

- [ ] **Step 5: Convert bid candidates in bundle model**

In `_bid_peak_from_dual_row` in `hoga/api/bundle.py`, add:

```python
traded_peaks=[_ask_candidate(date, c) for c in row.traded_peaks],
traded_max_peaks=[_ask_candidate(date, c) for c in row.traded_max_peaks],
```

The resulting constructor body should include these lines beside `max_t_ms`, matching `_ask_peak_from_dual_row`.

- [ ] **Step 6: Add model/bundle tests for bid candidate wire**

In `tests/test_api_ask_peak_model.py`, add:

```python
def test_bid_peak_model_accepts_ranked_candidates():
    peak = BidPeak(
        date="20260613",
        price=24900,
        qty=9000,
        t_ms=1,
        max_price=24900,
        max_qty=9000,
        max_t_ms=1,
        traded_peaks=[AskPeakCandidate(price=24900, qty=9000, t_ms=1)],
        traded_max_peaks=[AskPeakCandidate(price=24900, qty=9000, t_ms=1)],
    )

    assert peak.traded_peaks[0].price == 24900
    assert peak.traded_max_peaks[0].qty == 9000
```

In `tests/hoga/api/test_bundle.py`, extend `test_build_bid_peak_slice_wires_untraded_peak` or add a new adjacent test:

```python
def test_build_bid_peak_slice_wires_ranked_candidates(tmp_path) -> None:
    from unittest.mock import MagicMock
    from hoga.api.bundle import build_bid_peak_slice
    from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet
    from hoga.tables.trades import Trade, write_parquet as trades_write_parquet

    z = tuple([0] * 10)
    ap = tuple(70100 + 50 * i for i in range(10))
    aq = tuple([100] * 10)
    bp = (70000, 69900, 69800, 69700, 69600, 69500, 69400, 69300, 69200, 69100)
    ob1 = Orderbook(
        ts_ms=90100000, seq=1,
        ask_p=ap, ask_q=aq, ask_d=z,
        bid_p=bp, bid_q=(1000, 9000, 7000, 6000, 500, 6, 7, 8, 9, 1), bid_d=z,
        tot_ask=sum(aq), tot_ask_d=0, tot_bid=23531, tot_bid_d=0,
    )
    ob2 = Orderbook(
        ts_ms=90200000, seq=2,
        ask_p=ap, ask_q=aq, ask_d=z,
        bid_p=bp, bid_q=(3000, 8000, 7100, 100, 500, 6, 7, 8, 9, 1), bid_d=z,
        tot_ask=sum(aq), tot_ask_d=0, tot_bid=18731, tot_bid_d=0,
    )
    trades = [
        Trade(ts_ms=90050000, seq=1, price=70000, change_pct=0, qty=1, side=1,
              cum_vol=1, cum_trades=1, low_so_far=70000, high_so_far=70000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90060000, seq=2, price=69900, change_pct=0, qty=1, side=1,
              cum_vol=2, cum_trades=2, low_so_far=69900, high_so_far=70000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90070000, seq=3, price=69800, change_pct=0, qty=1, side=1,
              cum_vol=3, cum_trades=3, low_so_far=69800, high_so_far=70000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90080000, seq=4, price=69700, change_pct=0, qty=1, side=1,
              cum_vol=4, cum_trades=4, low_so_far=69700, high_so_far=70000,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
    ]
    snapshots_write_parquet([ob1, ob2], tmp_path / "snapshots.parquet")
    trades_write_parquet(trades, tmp_path / "trades.parquet")
    eng = MagicMock()
    eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
    eng.conn = duckdb.connect()

    p = build_bid_peak_slice(
        eng, code="005930", date="20260610", bucket_ms=60_000,
        source="hogaplay", session_open_ms=90000000, session_close_ms=153000000,
    )

    assert p is not None
    assert [c.model_dump() for c in p.traded_peaks] == [
        {"price": 69900, "qty": 9000, "t_ms": 1781049660000},
        {"price": 69800, "qty": 7100, "t_ms": 1781049720000},
        {"price": 69700, "qty": 6000, "t_ms": 1781049660000},
    ]
```

- [ ] **Step 7: Run backend tests**

Run:

```bash
pytest tests/test_tables_snapshots.py::test_query_day_ask_bid_peak_dual_returns_top_three_bid_traded_price_peaks \
  tests/hoga/api/test_bundle.py::test_build_bid_peak_slice_wires_ranked_candidates \
  tests/test_api_ask_peak_model.py::test_bid_peak_model_accepts_ranked_candidates -q
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add hoga/tables/snapshots.py hoga/api/models.py hoga/api/bundle.py frontend/src/api/types.ts tests/test_tables_snapshots.py tests/hoga/api/test_bundle.py tests/test_api_ask_peak_model.py
git commit -m "feat: expose bid peak ranked candidates"
```

---

### Task 2: Add Cutoff Preferences And Indicator UI Rows

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts`
- Modify: `frontend/src/state/chartPrefs.test.ts`
- Modify: `frontend/src/live/indicators/AskPeakConfig.tsx`
- Modify: `frontend/src/live/indicators/BidPeakConfig.tsx`
- Modify: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

**Interfaces:**
- Produces: `ChartToggleKey` values `askPeakVisibleTimeCutoff` and `bidPeakVisibleTimeCutoff`.
- Consumes: `IndicatorPrefRows` `toggleKeys` prop.

- [ ] **Step 1: Write failing chartPrefs tests**

Append to `frontend/src/state/chartPrefs.test.ts`:

```ts
describe('peak wall visible-time cutoff toggles', () => {
  it('defaults both cutoff toggles off in the indicator modal', () => {
    const ask = CHART_TOGGLES.find((t) => t.key === 'askPeakVisibleTimeCutoff');
    const bid = CHART_TOGGLES.find((t) => t.key === 'bidPeakVisibleTimeCutoff');

    expect(DEFAULT_PREFS.askPeakVisibleTimeCutoff).toBe(false);
    expect(DEFAULT_PREFS.bidPeakVisibleTimeCutoff).toBe(false);
    expect(ask?.label).toBe('보이는 최신 봉 기준');
    expect(bid?.label).toBe('보이는 최신 봉 기준');
    expect(categoryOf(ask!)).toBe('indicator-modal');
    expect(categoryOf(bid!)).toBe('indicator-modal');
  });

  it('persists ask and bid cutoff toggles independently', () => {
    const askOnly = mergePrefs({ askPeakVisibleTimeCutoff: true });
    expect(askOnly.askPeakVisibleTimeCutoff).toBe(true);
    expect(askOnly.bidPeakVisibleTimeCutoff).toBe(false);

    const bidOnly = mergePrefs({ bidPeakVisibleTimeCutoff: true });
    expect(bidOnly.askPeakVisibleTimeCutoff).toBe(false);
    expect(bidOnly.bidPeakVisibleTimeCutoff).toBe(true);
  });
});
```

- [ ] **Step 2: Write failing indicator panel UI tests**

In `frontend/src/live/indicators/IndicatorPanel.test.tsx`, update the ask detail test to include the new toggle:

```ts
it('매도 최대벽 선택 시 스타일 pane과 보이는 최신 봉 기준 토글 표시', () => {
  render(<IndicatorPanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '당일 매도 최대벽' }));
  expect(screen.getByRole('button', { name: '체결가격 기준 최대벽 스타일 선택' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '미체결 포함 최대벽 스타일 선택' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '보이는 영역 최대벽 스타일 선택' })).toBeTruthy();
  expect(screen.getByTestId('settings-toggle-askPeakVisibleTimeCutoff')).toBeTruthy();
});
```

Update the bid detail test to include:

```ts
expect(screen.getByTestId('settings-toggle-bidPeakVisibleTimeCutoff')).toBeTruthy();
```

- [ ] **Step 3: Run frontend tests and verify failure**

Run:

```bash
cd frontend
npm test -- --run src/state/chartPrefs.test.ts src/live/indicators/IndicatorPanel.test.tsx
```

Expected: FAIL because the new toggle keys are not registered and not rendered.

- [ ] **Step 4: Add toggle registry entries**

In `frontend/src/state/chartPrefs.ts`, add the ask toggle after `askPeakShowAllPrices`:

```ts
{
  key: 'askPeakVisibleTimeCutoff',
  label: '보이는 최신 봉 기준',
  description: '오른쪽 끝에 보이는 분봉 시각까지의 후보만 사용해 당일 매도 최대벽을 계산합니다.',
  default: false,
  category: 'indicator-modal',
},
```

Add the bid toggle after `bidPeakShowAllPrices`:

```ts
{
  key: 'bidPeakVisibleTimeCutoff',
  label: '보이는 최신 봉 기준',
  description: '오른쪽 끝에 보이는 분봉 시각까지의 후보만 사용해 당일 매수 최대벽을 계산합니다.',
  default: false,
  category: 'indicator-modal',
},
```

- [ ] **Step 5: Render rows in detail panes**

In `AskPeakConfig.tsx`, update the row block:

```tsx
<IndicatorPrefRows toggleKeys={['askPeakIntraMax', 'askPeakShowAllPrices', 'askPeakVisibleTimeCutoff']} />
```

In `BidPeakConfig.tsx`, update the row block:

```tsx
<IndicatorPrefRows toggleKeys={['bidPeakIntraMax', 'bidPeakShowAllPrices', 'bidPeakVisibleTimeCutoff']} />
```

- [ ] **Step 6: Run frontend tests**

Run:

```bash
cd frontend
npm test -- --run src/state/chartPrefs.test.ts src/live/indicators/IndicatorPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add frontend/src/state/chartPrefs.ts frontend/src/state/chartPrefs.test.ts frontend/src/live/indicators/AskPeakConfig.tsx frontend/src/live/indicators/BidPeakConfig.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx
git commit -m "feat: add peak wall visible candle toggles"
```

---

### Task 3: Build Pure Visible-Cutoff Candidate Selection

**Files:**
- Create: `frontend/src/live/peakWallVisibleCutoff.ts`
- Create: `frontend/src/live/peakWallVisibleCutoff.test.ts`
- Modify: `frontend/src/live/LiveAskPeakSegments.tsx`
- Modify: `frontend/src/live/LiveBidPeakSegments.tsx`
- Test: `frontend/src/live/LiveAskPeakSegments.test.tsx`
- Test: `frontend/src/live/LiveBidPeakSegments.test.tsx`

**Interfaces:**
- Produces: `type VisibleTimeCutoff = { date: string; tMs: number }`.
- Produces: `rightmostVisibleCandleCutoff(candles, visibleRange, axis): VisibleTimeCutoff | null`.
- Produces: `applyPeakVisibleTimeCutoff(peaks, cutoff, options): Peak[]`.
- Consumes: `AskPeak.traded_peaks`, `AskPeak.traded_max_peaks`, `BidPeak.traded_peaks`, `BidPeak.traded_max_peaks`.

- [ ] **Step 1: Write failing pure helper tests**

Create `frontend/src/live/peakWallVisibleCutoff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AskPeak, BidPeak, Candle } from '../api/types';
import { createVirtualAxis } from '../util/virtualAxis';
import {
  applyPeakVisibleTimeCutoff,
  rightmostVisibleCandleCutoff,
  type VisibleTimeCutoff,
} from './peakWallVisibleCutoff';

const day1Open = Date.UTC(2026, 5, 10, 0, 0);
const day1Close = Date.UTC(2026, 5, 10, 6, 30);
const day2Open = Date.UTC(2026, 5, 11, 0, 0);
const day2Close = Date.UTC(2026, 5, 11, 6, 30);

const axis = createVirtualAxis([
  { date: '20260610', sessionOpenMs: day1Open, sessionCloseMs: day1Close },
  { date: '20260611', sessionOpenMs: day2Open, sessionCloseMs: day2Close },
], day1Open);

const candle = (ts_ms: number): Candle => ({
  ts_ms,
  open: 1,
  high: 2,
  low: 1,
  close: 2,
  vol_a: 1,
  vol_b: 0,
});

const askPeak = (date: string): AskPeak => ({
  date,
  price: 100,
  qty: 100,
  t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000,
  max_price: 100,
  max_qty: 100,
  max_t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000,
  traded_peaks: [
    { price: 100, qty: 100, t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000 },
    { price: 101, qty: 500, t_ms: date === '20260610' ? day1Open + 180_000 : day2Open + 180_000 },
  ],
  traded_max_peaks: [
    { price: 100, qty: 110, t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000 },
    { price: 101, qty: 600, t_ms: date === '20260610' ? day1Open + 180_000 : day2Open + 180_000 },
  ],
  untraded_price: 102,
  untraded_qty: 700,
  untraded_t_ms: date === '20260610' ? day1Open + 180_000 : day2Open + 180_000,
  untraded_max_price: 102,
  untraded_max_qty: 800,
  untraded_max_t_ms: date === '20260610' ? day1Open + 180_000 : day2Open + 180_000,
});

describe('rightmostVisibleCandleCutoff', () => {
  it('uses the rightmost visible candle, clamping right-offset whitespace to the latest candle', () => {
    const candles = [candle(day1Open), candle(day1Open + 60_000), candle(day1Open + 120_000)];
    const visibleRange = {
      from: axis.toVirtual(day1Open) / 1000,
      to: axis.toVirtual(day1Open + 10 * 60_000) / 1000,
    };

    expect(rightmostVisibleCandleCutoff(candles, visibleRange, axis)).toEqual({
      date: '20260610',
      tMs: day1Open + 120_000,
    });
  });
});

describe('applyPeakVisibleTimeCutoff', () => {
  it('keeps earlier dates full-day, filters the cutoff date, and omits later dates', () => {
    const cutoff: VisibleTimeCutoff = { date: '20260611', tMs: day2Open + 120_000 };

    const out = applyPeakVisibleTimeCutoff([askPeak('20260610'), askPeak('20260611')], cutoff, {
      side: 'ask',
      intraMax: false,
    });

    expect(out).toHaveLength(2);
    expect(out[0].date).toBe('20260610');
    expect(out[0].qty).toBe(100);
    expect(out[1]).toMatchObject({
      date: '20260611',
      price: 100,
      qty: 100,
      t_ms: day2Open + 60_000,
    });
    expect(out[1].untraded_price).toBeNull();
  });

  it('omits the cutoff date when every candidate is after the cutoff', () => {
    const cutoff: VisibleTimeCutoff = { date: '20260611', tMs: day2Open + 30_000 };

    expect(applyPeakVisibleTimeCutoff([askPeak('20260611')], cutoff, {
      side: 'ask',
      intraMax: false,
    })).toEqual([]);
  });

  it('uses bid ranked candidates the same way as ask ranked candidates', () => {
    const bid: BidPeak = {
      ...askPeak('20260611'),
      price: 99,
      max_price: 99,
      traded_peaks: [
        { price: 99, qty: 90, t_ms: day2Open + 60_000 },
        { price: 98, qty: 900, t_ms: day2Open + 180_000 },
      ],
      traded_max_peaks: [
        { price: 99, qty: 95, t_ms: day2Open + 60_000 },
        { price: 98, qty: 950, t_ms: day2Open + 180_000 },
      ],
    };

    const out = applyPeakVisibleTimeCutoff([bid], { date: '20260611', tMs: day2Open + 120_000 }, {
      side: 'bid',
      intraMax: false,
    });

    expect(out).toEqual([expect.objectContaining({ price: 99, qty: 90, t_ms: day2Open + 60_000 })]);
  });
});
```

- [ ] **Step 2: Run helper tests and verify failure**

Run:

```bash
cd frontend
npm test -- --run src/live/peakWallVisibleCutoff.test.ts
```

Expected: FAIL because `peakWallVisibleCutoff.ts` does not exist.

- [ ] **Step 3: Implement pure helper**

Create `frontend/src/live/peakWallVisibleCutoff.ts`:

```ts
import type { IRange, Time } from 'lightweight-charts';
import type { AskPeak, AskPeakCandidate, BidPeak, Candle, PeakBase } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { realMsToYyyymmdd } from './liveDateTime';

export type VisibleTimeCutoff = {
  date: string;
  tMs: number;
};

type PeakSide = 'ask' | 'bid';

type CutoffOptions = {
  side: PeakSide;
  intraMax: boolean;
};

type PeakWithCandidates = (AskPeak | BidPeak) & {
  traded_peaks?: AskPeakCandidate[];
  traded_max_peaks?: AskPeakCandidate[];
};

function finiteTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function rightmostVisibleCandleCutoff(
  candles: readonly Candle[],
  visibleRange: IRange<Time> | null,
  axis: VirtualAxis,
): VisibleTimeCutoff | null {
  if (!visibleRange || candles.length === 0) return null;
  const visibleTo = Number(visibleRange.to) * 1000;
  if (!Number.isFinite(visibleTo)) return null;
  const realTo = axis.toReal(visibleTo);
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].ts_ms <= realTo) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const candle = candles[ans >= 0 ? ans : 0];
  if (!candle) return null;
  return { date: realMsToYyyymmdd(candle.ts_ms), tMs: candle.ts_ms };
}

function candidateFromPeak(peak: PeakBase, intraMax: boolean): AskPeakCandidate {
  return intraMax
    ? { price: peak.max_price, qty: peak.max_qty, t_ms: peak.max_t_ms }
    : { price: peak.price, qty: peak.qty, t_ms: peak.t_ms };
}

function maxCandidateFromPeak(peak: PeakBase, intraMax: boolean): AskPeakCandidate {
  return intraMax
    ? { price: peak.max_price, qty: peak.max_qty, t_ms: peak.max_t_ms }
    : { price: peak.price, qty: peak.qty, t_ms: peak.t_ms };
}

function chooseCandidate(
  peak: PeakWithCandidates,
  cutoff: VisibleTimeCutoff,
  intraMax: boolean,
): { close: AskPeakCandidate; max: AskPeakCandidate } | null {
  const closeCandidates = peak.traded_peaks?.length
    ? peak.traded_peaks
    : [candidateFromPeak(peak, false)];
  const maxCandidates = peak.traded_max_peaks?.length
    ? peak.traded_max_peaks
    : [maxCandidateFromPeak(peak, true)];
  const candidates = (intraMax ? maxCandidates : closeCandidates)
    .filter((candidate) => candidate.t_ms <= cutoff.tMs)
    .sort((a, b) => b.qty - a.qty || a.t_ms - b.t_ms || a.price - b.price);
  const selected = candidates[0];
  if (!selected) return null;
  const selectedIndex = (intraMax ? maxCandidates : closeCandidates).findIndex((candidate) =>
    candidate.price === selected.price && candidate.qty === selected.qty && candidate.t_ms === selected.t_ms);
  const fallbackIndex = selectedIndex >= 0 ? selectedIndex : 0;
  return {
    close: closeCandidates[fallbackIndex] ?? selected,
    max: maxCandidates[fallbackIndex] ?? selected,
  };
}

function cutoffNullableTriple<T extends PeakWithCandidates>(
  peak: T,
  cutoff: VisibleTimeCutoff,
  prefix: 'untraded' | 'all',
): Partial<T> {
  const price = peak[`${prefix}_price` as keyof T] as number | null | undefined;
  const qty = peak[`${prefix}_qty` as keyof T] as number | null | undefined;
  const tMs = finiteTime(peak[`${prefix}_t_ms` as keyof T]);
  const maxPrice = peak[`${prefix}_max_price` as keyof T] as number | null | undefined;
  const maxQty = peak[`${prefix}_max_qty` as keyof T] as number | null | undefined;
  const maxTMs = finiteTime(peak[`${prefix}_max_t_ms` as keyof T]);
  const closeOk = tMs !== null && tMs <= cutoff.tMs;
  const maxOk = maxTMs !== null && maxTMs <= cutoff.tMs;
  return {
    [`${prefix}_price`]: closeOk ? price : null,
    [`${prefix}_qty`]: closeOk ? qty : null,
    [`${prefix}_t_ms`]: closeOk ? tMs : null,
    [`${prefix}_max_price`]: maxOk ? maxPrice : null,
    [`${prefix}_max_qty`]: maxOk ? maxQty : null,
    [`${prefix}_max_t_ms`]: maxOk ? maxTMs : null,
  } as Partial<T>;
}

export function applyPeakVisibleTimeCutoff<T extends PeakWithCandidates>(
  peaks: readonly T[],
  cutoff: VisibleTimeCutoff | null,
  options: CutoffOptions,
): T[] {
  if (!cutoff) return [...peaks];
  const out: T[] = [];
  for (const peak of peaks) {
    if (peak.date < cutoff.date) {
      out.push(peak);
      continue;
    }
    if (peak.date > cutoff.date) continue;
    const selected = chooseCandidate(peak, cutoff, options.intraMax);
    if (!selected) continue;
    out.push({
      ...peak,
      price: selected.close.price,
      qty: selected.close.qty,
      t_ms: selected.close.t_ms,
      max_price: selected.max.price,
      max_qty: selected.max.qty,
      max_t_ms: selected.max.t_ms,
      ...cutoffNullableTriple(peak, cutoff, 'untraded'),
      ...cutoffNullableTriple(peak, cutoff, 'all'),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
cd frontend
npm test -- --run src/live/peakWallVisibleCutoff.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add overlay builder tests**

In `frontend/src/live/LiveAskPeakSegments.test.tsx`, add a test that calls `buildAskPeakOverlaySegments` with `visibleTimeCutoff`:

```ts
it('filters ask baseline and untraded candidates by visible-time cutoff', () => {
  const day = '20260613';
  const open = Date.UTC(2026, 5, 13, 0, 0);
  const peak = {
    date: day,
    price: 100,
    qty: 100,
    t_ms: open + 60_000,
    max_price: 100,
    max_qty: 100,
    max_t_ms: open + 60_000,
    traded_peaks: [
      { price: 100, qty: 100, t_ms: open + 60_000 },
      { price: 101, qty: 900, t_ms: open + 180_000 },
    ],
    traded_max_peaks: [
      { price: 100, qty: 100, t_ms: open + 60_000 },
      { price: 101, qty: 900, t_ms: open + 180_000 },
    ],
    untraded_price: 102,
    untraded_qty: 950,
    untraded_t_ms: open + 180_000,
    untraded_max_price: null,
    untraded_max_qty: null,
    untraded_max_t_ms: null,
  } as never;

  const segments = buildAskPeakOverlaySegments({
    dayAskPeaks: [peak],
    todayAllPriceAskPeak: null,
    segments: [{ date: day, session_open_ms: open, session_close_ms: open + 3600_000 }],
    candles: [{ ts_ms: open, open: 1, high: 2, low: 1, close: 2, vol_a: 1, vol_b: 0 }],
    axis: createVirtualAxis([{ date: day, sessionOpenMs: open, sessionCloseMs: open + 3600_000 }], open),
    todayKst: day,
    baselineStyle: { color: '#fff', lineWidth: 1 },
    allPriceStyle: { color: '#f00', lineWidth: 1 },
    intraMax: false,
    showAllPrices: true,
    visibleTimeCutoff: { date: day, tMs: open + 120_000 },
  });

  expect(segments).toHaveLength(1);
  expect(segments[0]).toMatchObject({ price: 100, qty: 100 });
});
```

Use the existing test file imports for `createVirtualAxis` and type fixtures. If the file does not import `createVirtualAxis`, add `import { createVirtualAxis } from '../util/virtualAxis';`.

In `frontend/src/live/LiveBidPeakSegments.test.tsx`, add the same shape for bid:

```ts
it('filters bid baseline candidates by visible-time cutoff', () => {
  const day = '20260613';
  const open = Date.UTC(2026, 5, 13, 0, 0);
  const peak = {
    date: day,
    price: 99,
    qty: 90,
    t_ms: open + 60_000,
    max_price: 99,
    max_qty: 90,
    max_t_ms: open + 60_000,
    traded_peaks: [
      { price: 99, qty: 90, t_ms: open + 60_000 },
      { price: 98, qty: 900, t_ms: open + 180_000 },
    ],
    traded_max_peaks: [
      { price: 99, qty: 90, t_ms: open + 60_000 },
      { price: 98, qty: 900, t_ms: open + 180_000 },
    ],
  };

  const segments = buildBidPeakOverlaySegments({
    dayBidPeaks: [peak],
    todayAllPriceBidPeak: null,
    segments: [{ date: day, session_open_ms: open, session_close_ms: open + 3600_000 }],
    candles: [{ ts_ms: open, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 }],
    axis: createVirtualAxis([{ date: day, sessionOpenMs: open, sessionCloseMs: open + 3600_000 }], open),
    todayKst: day,
    baselineStyle: { color: '#fff', lineWidth: 1 },
    allPriceStyle: { color: '#f00', lineWidth: 1 },
    intraMax: false,
    showAllPrices: true,
    visibleTimeCutoff: { date: day, tMs: open + 120_000 },
  });

  expect(segments).toHaveLength(1);
  expect(segments[0]).toMatchObject({ price: 99, qty: 90 });
});
```

- [ ] **Step 6: Update overlay builders to consume cutoff**

In `LiveAskPeakSegments.tsx`, import the helper:

```ts
import { applyPeakVisibleTimeCutoff, type VisibleTimeCutoff } from './peakWallVisibleCutoff';
```

Extend `BuildAskPeakOverlaySegmentsArgs`:

```ts
visibleTimeCutoff?: VisibleTimeCutoff | null;
```

At the start of `buildAskPeakOverlaySegments`, before `expandBaselinePeaks`, add:

```ts
const cutoffPeaks = applyPeakVisibleTimeCutoff(dayAskPeaks, visibleTimeCutoff ?? null, {
  side: 'ask',
  intraMax,
});
const baselinePeaks = expandBaselinePeaks(cutoffPeaks, allPriceRankLimit, intraMax);
```

Remove the previous `const baselinePeaks = expandBaselinePeaks(dayAskPeaks, allPriceRankLimit, intraMax);` line.

When checking today's all-price candidate, do not allow it after cutoff:

```ts
const todayAllPriceCandidate =
  todayAllPriceAskPeak && (!visibleTimeCutoff || todayAllPriceAskPeak.t_ms <= visibleTimeCutoff.tMs)
    ? todayAllPriceAskPeak
    : null;
```

Use `todayAllPriceCandidate` instead of `todayAllPriceAskPeak` in the untraded candidate block.

In `LiveBidPeakSegments.tsx`, import the same helper, add `visibleTimeCutoff?: VisibleTimeCutoff | null` to args, and replace the baseline source:

```ts
const cutoffPeaks = applyPeakVisibleTimeCutoff(dayBidPeaks, visibleTimeCutoff ?? null, {
  side: 'bid',
  intraMax,
});
const baseline = buildBidPeakSegments(
  cutoffPeaks,
  segments,
  candles,
  axis,
  todayKst,
  baselineStyle.color,
  baselineStyle.lineWidth,
  intraMax,
);
```

Loop over `cutoffPeaks` for untraded candidates.

- [ ] **Step 7: Run frontend tests**

Run:

```bash
cd frontend
npm test -- --run src/live/peakWallVisibleCutoff.test.ts src/live/LiveAskPeakSegments.test.tsx src/live/LiveBidPeakSegments.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add frontend/src/live/peakWallVisibleCutoff.ts frontend/src/live/peakWallVisibleCutoff.test.ts frontend/src/live/LiveAskPeakSegments.tsx frontend/src/live/LiveAskPeakSegments.test.tsx frontend/src/live/LiveBidPeakSegments.tsx frontend/src/live/LiveBidPeakSegments.test.tsx
git commit -m "feat: filter peak walls by visible candle cutoff"
```

---

### Task 4: Wire Visible Cutoff Through LiveChartRoot For `/live` And `/study`

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/LiveChartRoot.test.tsx`

**Interfaces:**
- Consumes: `useActivePrefs((s) => s.askPeakVisibleTimeCutoff)` and `bidPeakVisibleTimeCutoff`.
- Consumes: `rightmostVisibleCandleCutoff(candles, visibleRange, axis)`.
- Produces: side-specific `visibleTimeCutoff` arguments to `buildAskPeakOverlaySegments`, `LiveAskPeakSegments`, `buildBidPeakOverlaySegments`, and `LiveBidPeakSegments`.

- [ ] **Step 1: Write failing LiveChartRoot test**

In `frontend/src/live/LiveChartRoot.test.tsx`, add a test near other peak-wall or visible-range tests:

```ts
it('passes rightmost visible candle cutoff to peak wall overlays when cutoff toggles are enabled', async () => {
  const { useChartPrefsStore } = await import('../state/chartPrefs');
  const { useLivePageStore } = await import('../state/livePage');
  useChartPrefsStore.getState().setToggle('askPeakVisibleTimeCutoff', true);
  useChartPrefsStore.getState().setToggle('bidPeakVisibleTimeCutoff', true);
  useLivePageStore.setState({ askPeakEnabled: true, bidPeakEnabled: true });

  const open = TODAY_OPEN_MS;
  const candles = [
    candleAt(open),
    candleAt(open + 60_000),
    candleAt(open + 120_000),
  ];
  const bundle = makeBundle({
    candles,
    segments: [{ date: '20260613', session_open_ms: open, session_close_ms: open + 3600_000 }],
    ask_peaks: [{
      date: '20260613',
      price: 100,
      qty: 100,
      t_ms: open + 60_000,
      max_price: 100,
      max_qty: 100,
      max_t_ms: open + 60_000,
      traded_peaks: [
        { price: 100, qty: 100, t_ms: open + 60_000 },
        { price: 101, qty: 900, t_ms: open + 180_000 },
      ],
    }],
    bid_peaks: [{
      date: '20260613',
      price: 99,
      qty: 90,
      t_ms: open + 60_000,
      max_price: 99,
      max_qty: 90,
      max_t_ms: open + 60_000,
      traded_peaks: [
        { price: 99, qty: 90, t_ms: open + 60_000 },
        { price: 98, qty: 900, t_ms: open + 180_000 },
      ],
    }],
  });
  ts.getVisibleRange.mockReturnValue({
    from: open / 1000,
    to: (open + 120_000) / 1000,
  });

  render(<LiveChartRoot
    code="005930"
    timeframe="1m"
    bundle={bundle}
    chartBundle={bundle}
    clampEngaged={false}
    isPastCandlesLoading={false}
    todayKst="20260613"
    dayAskPeaks={bundle.ask_peaks}
    dayBidPeaks={bundle.bid_peaks}
  />);

  await waitFor(() => expect(attachedPeakWallPrimitives.length).toBeGreaterThanOrEqual(2));
  const renderedPrices = attachedPeakWallPrimitives.flatMap((primitive) =>
    primitive.segmentsForTest().map((segment) => segment.price));
  expect(renderedPrices).toContain(100);
  expect(renderedPrices).toContain(99);
  expect(renderedPrices).not.toContain(101);
  expect(renderedPrices).not.toContain(98);
});
```

Adapt helper names to the existing mock utilities in this test file. If `AskPeakSegmentsPrimitive` does not expose `segmentsForTest`, mock it in this test file the same way existing primitive tests do: store the last `setSegments` argument in an array local to the test module.

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
cd frontend
npm test -- --run src/live/LiveChartRoot.test.tsx -t "passes rightmost visible candle cutoff"
```

Expected: FAIL because cutoff is not derived or passed.

- [ ] **Step 3: Derive side-specific cutoff in LiveChartRoot**

In `LiveChartRoot.tsx`, import:

```ts
import {
  rightmostVisibleCandleCutoff,
  type VisibleTimeCutoff,
} from './peakWallVisibleCutoff';
```

Read the toggles near existing active prefs:

```ts
const askPeakVisibleTimeCutoff = useActivePrefs((s) => s.askPeakVisibleTimeCutoff);
const bidPeakVisibleTimeCutoff = useActivePrefs((s) => s.bidPeakVisibleTimeCutoff);
const [visibleTimeCutoff, setVisibleTimeCutoff] = useState<VisibleTimeCutoff | null>(null);
```

Add an effect after `axis`, `cb`, and `chart` are available:

```ts
useEffect(() => {
  if (!chart || !cb || !isMinuteTimeframe(timeframe)) {
    setVisibleTimeCutoff(null);
    return undefined;
  }
  const timeScale = chart.timeScale();
  const update = () => {
    setVisibleTimeCutoff(rightmostVisibleCandleCutoff(
      cb.candles,
      timeScale.getVisibleRange(),
      axis,
    ));
  };
  update();
  timeScale.subscribeVisibleTimeRangeChange(update);
  return () => {
    timeScale.unsubscribeVisibleTimeRangeChange(update);
  };
}, [chart, cb, cb?.candles, axis, timeframe]);
```

Derive side-specific values:

```ts
const askVisibleTimeCutoffForRender = askPeakVisibleTimeCutoff ? visibleTimeCutoff : null;
const bidVisibleTimeCutoffForRender = bidPeakVisibleTimeCutoff ? visibleTimeCutoff : null;
```

- [ ] **Step 4: Pass cutoff to high/low avoidance builders**

In the `highLowAvoidLabelYLines` memo, add `visibleTimeCutoff` args:

```ts
visibleTimeCutoff: askVisibleTimeCutoffForRender,
```

for ask, and:

```ts
visibleTimeCutoff: bidVisibleTimeCutoffForRender,
```

for bid.

Add `askVisibleTimeCutoffForRender` and `bidVisibleTimeCutoffForRender` to the dependency array.

- [ ] **Step 5: Pass cutoff to rendered overlay components**

Extend `LiveAskPeakSegments` props:

```ts
visibleTimeCutoff?: VisibleTimeCutoff | null;
```

Pass it into `buildAskPeakOverlaySegments`:

```ts
visibleTimeCutoff,
```

Add `visibleTimeCutoff` to the component arguments and `updateSegments` dependency array.

Extend `LiveBidPeakSegments` the same way and pass into `buildBidPeakOverlaySegments`.

At the component mount sites in `LiveChartRoot.tsx`, pass:

```tsx
visibleTimeCutoff={askVisibleTimeCutoffForRender}
```

and:

```tsx
visibleTimeCutoff={bidVisibleTimeCutoffForRender}
```

- [ ] **Step 6: Run LiveChartRoot test**

Run:

```bash
cd frontend
npm test -- --run src/live/LiveChartRoot.test.tsx -t "passes rightmost visible candle cutoff"
```

Expected: PASS.

- [ ] **Step 7: Run related frontend tests**

Run:

```bash
cd frontend
npm test -- --run src/live/LiveChartRoot.test.tsx src/live/LiveAskPeakSegments.test.tsx src/live/LiveBidPeakSegments.test.tsx src/live/peakWallVisibleCutoff.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.test.tsx frontend/src/live/LiveAskPeakSegments.tsx frontend/src/live/LiveBidPeakSegments.tsx
git commit -m "feat: wire peak wall cutoff to visible chart range"
```

---

### Task 5: Final Verification And Documentation Sweep

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-peak-wall-visible-time-cutoff-design.md` only if implementation discovers a corrected behavior.
- Test: backend and frontend targeted suites.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: verified working implementation with no known doc drift.

- [ ] **Step 1: Run backend peak tests**

Run:

```bash
pytest tests/test_tables_snapshots.py tests/hoga/api/test_bundle.py tests/test_api_ask_peak_model.py -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend peak/settings tests**

Run:

```bash
cd frontend
npm test -- --run \
  src/state/chartPrefs.test.ts \
  src/live/indicators/IndicatorPanel.test.tsx \
  src/live/peakWallVisibleCutoff.test.ts \
  src/live/LiveAskPeakSegments.test.tsx \
  src/live/LiveBidPeakSegments.test.tsx \
  src/live/LiveChartRoot.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run frontend type/build check**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS with Vite build output and no TypeScript errors.

- [ ] **Step 4: Check git diff for unrelated churn**

Run:

```bash
git diff --stat HEAD
git diff --name-only HEAD
```

Expected: only files listed in this plan appear.

- [ ] **Step 5: Commit final verification metadata if docs changed**

If Step 4 shows only code changes already committed and no docs changed, skip this commit. If spec wording was corrected during implementation, run:

```bash
git add docs/superpowers/specs/2026-07-04-peak-wall-visible-time-cutoff-design.md
git commit -m "docs: align peak wall cutoff spec with implementation"
```

Expected: commit succeeds only when there are staged doc changes.

---

## Self-Review

**Spec coverage:** The plan covers independent ask/bid toggles, default-off prefs, `/live` and `/study` shared wiring through `LiveChartRoot`, rightmost visible candle cutoff, today/historical candidate filtering, multi-date viewport rules, no full-day fallback in cutoff mode, and bid ranked candidate expansion.

**Placeholder scan:** Each task has file paths, commands, expected outcomes, and concrete code snippets for the core edits. The remaining `...` tokens are TypeScript/Python spread or tuple syntax inside code blocks, not omitted work.

**Type consistency:** The plan uses `VisibleTimeCutoff`, `rightmostVisibleCandleCutoff`, `applyPeakVisibleTimeCutoff`, `askPeakVisibleTimeCutoff`, `bidPeakVisibleTimeCutoff`, `traded_peaks`, and `traded_max_peaks` consistently across backend, wire types, helper tests, overlay builders, and `LiveChartRoot`.
