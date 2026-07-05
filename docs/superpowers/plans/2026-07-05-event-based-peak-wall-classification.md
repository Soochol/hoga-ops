# Event-Based Peak Wall Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change `당일 매도 최대벽` and `당일 매수 최대벽` so repeated same-price wall events are classified by later tick touch per event, and add independent rank 1-3 controls for `체결된 벽` and `미체결된 벽`.

**Architecture:** Keep legacy API field names (`traded_*`, `untraded_*`, `all_*`) for compatibility, but make their domain meaning event-based: `traded_*` means post-touch and `untraded_*` means post-untouched. Historical DuckDB queries classify orderbook level events against later continuous-trading ticks using `(ts_ms, seq)`. Live state mirrors the same rule with `t_ms` fallback. Frontend hooks and segment builders consume ranked candidate arrays and render post-touch/post-untouched families independently.

**Tech Stack:** Python 3 + DuckDB + Pydantic + pytest backend; React 18 + TypeScript + Zustand + lightweight-charts + Vitest frontend.

## Global Constraints

- Canonical domain terms: `사후터치 최대벽` and `사후미터치 최대벽`.
- UI labels: `체결된 벽` and `미체결된 벽`.
- Legacy wire names stay unchanged: `traded_*` for post-touch, `untraded_*` for post-untouched, `all_*` for all candidates.
- Ask post-touch rule: later continuous trade tick has `trade.price >= wall.price`.
- Bid post-touch rule: later continuous trade tick has `trade.price <= wall.price`.
- Historical ordering: tick is later when `(trade.ts_ms, trade.seq) >= (wall.ts_ms, wall.seq)`.
- Live fallback ordering: use inclusive `trade.t_ms >= wall.t_ms` when `seq` is unavailable.
- Only continuous-trading ticks count: `side IN (1, -1)`. `side = 0` auction-cross ticks never classify a wall as post-touch.
- Same-price wall events must remain distinguishable by event time and sequence until after classification.
- Post-touch and post-untouched ranks are independent. A post-untouched wall does not need to be larger than a post-touch wall to render.
- Rank limits are bounded to `1 | 2 | 3`; defaults remain `1` for post-touch and `1` for post-untouched.
- Visible-time cutoff filters candidate wall events and trade ticks before classification/ranking for the cutoff date.
- `/live` and `/study` behavior must match because both use the shared live chart indicator path.
- Do not rename persisted preference key `askPeakAllPriceRankLimit` or `bidPeakAllPriceRankLimit` in this change.

---

## File Structure

- `hoga/tables/snapshots.py`: replace price-membership/day-high-low classification with event-based post-touch/post-untouched classification; add ranked `untraded_peaks` and `untraded_max_peaks` to ask/bid row dataclasses.
- `hoga/api/models.py`: add ranked post-untouched arrays to `AskPeak` and `BidPeak`; update comments to legacy-wire/domain-term language.
- `hoga/api/bundle.py`: map new row arrays into API models and keep single `untraded_*` fields populated from rank 1.
- `hoga/live/ask_peak_state.py`: store wall events, classify by later tick touch, and publish `traded_peaks` plus `untraded_peaks` for ask and bid.
- `hoga/live/stream.py`: pass live tick time/order data into peak state where available without changing public stream shape.
- `frontend/src/api/types.ts`: mirror `untraded_peaks` and `untraded_max_peaks` on `AskPeak` and `BidPeak`.
- `frontend/src/live/peakWallEventClassifier.ts`: new pure frontend helper for event classification/ranking from live orderbook snapshots and trade ticks.
- `frontend/src/live/useDayAskPeaks.ts`: use event classifier for today's ask post-touch/post-untouched candidates; stop using candle range coverage as a touch classifier.
- `frontend/src/live/useDayBidPeaks.ts`: same for bid.
- `frontend/src/live/peakWallVisibleCutoff.ts`: extend cutoff filtering to post-untouched arrays.
- `frontend/src/live/LiveAskPeakSegments.tsx`: render ranked post-touch and ranked post-untouched ask families independently.
- `frontend/src/live/LiveBidPeakSegments.tsx`: same for bid.
- `frontend/src/live/LiveChartRoot.tsx`: pass the new post-untouched rank limits into ask/bid overlay builders.
- `frontend/src/live/LivePeakWallDockedLabels.tsx`: use the same rank limits and segment builders as chart overlays.
- `frontend/src/state/chartPrefs.ts`: add `askPeakUntradedRankLimit` and `bidPeakUntradedRankLimit`; relabel existing post-touch rank prefs.
- `frontend/src/live/indicators/AskPeakConfig.tsx`: add ask post-untouched rank selector and relabel post-touch selector.
- `frontend/src/live/indicators/BidPeakConfig.tsx`: add bid post-untouched rank selector and relabel post-touch selector.
- Tests:
  - `tests/test_tables_snapshots.py`
  - `tests/test_api_ask_peak_model.py`
  - `tests/hoga/api/test_bundle.py`
  - `tests/unit/live/test_ask_peak_state.py`
  - `tests/unit/live/test_stream.py`
  - `frontend/src/live/peakWallEventClassifier.test.ts`
  - `frontend/src/live/useDayAskPeaks.test.tsx`
  - `frontend/src/live/useDayBidPeaks.test.tsx`
  - `frontend/src/live/LiveAskPeakSegments.test.tsx`
  - `frontend/src/live/LiveBidPeakSegments.test.tsx`
  - `frontend/src/live/peakWallVisibleCutoff.test.ts`
  - `frontend/src/state/chartPrefs.test.ts`
  - `frontend/src/live/indicators/IndicatorPanel.test.tsx`

---

## Task 1: Lock Backend Wire Contract For Ranked Post-Untouched Arrays

**Files:**
- Modify: `hoga/tables/snapshots.py`
- Modify: `hoga/api/models.py`
- Modify: `hoga/api/bundle.py`
- Modify: `frontend/src/api/types.ts`
- Test: `tests/test_api_ask_peak_model.py`
- Test: `tests/hoga/api/test_bundle.py`

**Interfaces:**
- Produces: `AskPeakDualRow.untraded_peaks: tuple[AskPeakCandidateRow, ...]`
- Produces: `AskPeakDualRow.untraded_max_peaks: tuple[AskPeakCandidateRow, ...]`
- Produces: `BidPeakDualRow.untraded_peaks: tuple[AskPeakCandidateRow, ...]`
- Produces: `BidPeakDualRow.untraded_max_peaks: tuple[AskPeakCandidateRow, ...]`
- Produces: `AskPeak.untraded_peaks`, `AskPeak.untraded_max_peaks`, `BidPeak.untraded_peaks`, `BidPeak.untraded_max_peaks`
- Preserves: single `untraded_*` fields as rank-1 compatibility fields.

- [ ] Add failing model tests in `tests/test_api_ask_peak_model.py` asserting `AskPeak` and `BidPeak` accept `untraded_peaks` and `untraded_max_peaks` lists.
- [ ] Add failing bundle conversion tests in `tests/hoga/api/test_bundle.py` constructing `AskPeakDualRow` and `BidPeakDualRow` with two `untraded_peaks` each, then asserting `_ask_peak_from_dual_row` and `_bid_peak_from_dual_row` preserve arrays and populate single `untraded_*` from the first candidate.
- [ ] Run:

```bash
pytest tests/test_api_ask_peak_model.py tests/hoga/api/test_bundle.py -q
```

Expected: fail on missing `untraded_peaks` / `untraded_max_peaks`.

- [ ] Add the four tuple fields to `AskPeakDualRow` and `BidPeakDualRow` in `hoga/tables/snapshots.py` with `= ()` defaults.
- [ ] Add `untraded_peaks` and `untraded_max_peaks` fields to `AskPeak` and `BidPeak` in `hoga/api/models.py`, using `Field(default_factory=list)`.
- [ ] Update model docstrings/comments so `traded_*` is documented as legacy wire for post-touch and `untraded_*` as legacy wire for post-untouched.
- [ ] Update `_ask_peak_from_dual_row` and `_bid_peak_from_dual_row` in `hoga/api/bundle.py` to map the new arrays with `_ask_candidate`.
- [ ] When row arrays are non-empty, populate single `untraded_*` and `untraded_max_*` from array rank 1; when arrays are empty, keep existing single fields if present for legacy compatibility.
- [ ] Mirror the new optional arrays on `AskPeak` and `BidPeak` in `frontend/src/api/types.ts`.
- [ ] Re-run:

```bash
pytest tests/test_api_ask_peak_model.py tests/hoga/api/test_bundle.py -q
```

Expected: PASS.

---

## Task 2: Replace Historical Price-Membership Classification With Event Classification

**Files:**
- Modify: `hoga/tables/snapshots.py`
- Test: `tests/test_tables_snapshots.py`

**Interfaces:**
- Consumes: orderbook snapshot rows with `ts_ms`, `seq`, ask/bid prices and quantities.
- Consumes: trade rows with `ts_ms`, `seq`, `price`, `side`.
- Produces: ranked post-touch arrays in existing `traded_peaks` and `traded_max_peaks`.
- Produces: ranked post-untouched arrays in new `untraded_peaks` and `untraded_max_peaks`.

- [ ] Update test helpers in `tests/test_tables_snapshots.py` so `_trade(...)`, `_ob_ap(...)`, and `_ob_bp(...)` can accept explicit `seq` while preserving current defaults.
- [ ] Add an ask regression test where:
  - `10:00:00` has ask wall `50000 / 100000`.
  - `10:05:00` has continuous trade at `50000`.
  - `10:20:00` has ask wall `50000 / 200000`.
  - No later trade reaches `50000`.
  - Expected: first event appears in `ask.traded_peaks`; second event appears in `ask.untraded_peaks`.
- [ ] Add a bid regression test with the same shape, using `trade.price <= wall.price` for touch.
- [ ] Add an ask test proving a prior trade at the same price before the wall does not classify the later wall.
- [ ] Add a bid test proving a prior trade at the same price before the wall does not classify the later wall.
- [ ] Add same-millisecond sequence tests:
  - wall `(ts_ms=90000000, seq=10)` and trade `(ts_ms=90000000, seq=10)` touches.
  - wall `(ts_ms=90000000, seq=10)` and trade `(ts_ms=90000000, seq=9)` does not touch unless a later tick also touches.
- [ ] Add `side=0` auction-cross tests for ask and bid proving crossing prices do not classify post-touch.
- [ ] Add rank tests proving top three post-touch and top three post-untouched candidates are returned independently for close-representative and intra-bar-max arrays.
- [ ] Run:

```bash
pytest tests/test_tables_snapshots.py -q
```

Expected: fail on old `price IN traded_prices`, day-high/day-low, and missing post-untouched arrays.

- [ ] In `query_day_ask_bid_peak_dual`, change `level_union(src, side)` to include `ts_ms`, `seq`, `price`, `qty`, `intra_ms`, and `bucket_id`.
- [ ] Change representative selection to order by `ts_ms DESC, seq DESC` inside each bucket.
- [ ] Build `touch_ticks` from `read_parquet(trades_path)` with `side IN (1, -1)` and `price > 0`, carrying `ts_ms`, `seq`, and `price`.
- [ ] Replace `traded_prices` and `day_extremes` classifiers with event-level predicates:

```sql
EXISTS (
  SELECT 1
  FROM touch_ticks t
  WHERE (t.ts_ms > l.ts_ms OR (t.ts_ms = l.ts_ms AND t.seq >= l.seq))
    AND t.price >= l.price
)
```

for ask post-touch, and:

```sql
EXISTS (
  SELECT 1
  FROM touch_ticks t
  WHERE (t.ts_ms > l.ts_ms OR (t.ts_ms = l.ts_ms AND t.seq >= l.seq))
    AND t.price <= l.price
)
```

for bid post-touch.

- [ ] Define post-untouched as the negation of the side-specific post-touch predicate after the same session/book filters.
- [ ] Rank each family with `ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC`.
- [ ] Keep event rows separate before classification. Do not collapse by price before touched/untouched split.
- [ ] Do not dedupe by price in SQL before classification. Return ranked event candidates; frontend segment expansion is responsible for deduping duplicate prices within each rendered family after ranking.
- [ ] Populate:
  - `ask_traded_close`, `ask_traded_max`, `ask_traded_peaks`, `ask_traded_max_peaks`
  - `ask_untraded_close`, `ask_untraded_max`, `ask_untraded_peaks`, `ask_untraded_max_peaks`
  - `bid_traded_close`, `bid_traded_max`, `bid_traded_peaks`, `bid_traded_max_peaks`
  - `bid_untraded_close`, `bid_untraded_max`, `bid_untraded_peaks`, `bid_untraded_max_peaks`
- [ ] Remove fallback that invents a traded peak from `all_*` when no post-touch candidate exists. `traded_peaks` may be empty.
- [ ] Update separate `query_day_ask_peak_dual` and `query_day_bid_peak_dual` to either share the same event-classification helper or delegate to `query_day_ask_bid_peak_dual` and return one side. Their outputs must match the shared query for the same inputs.
- [ ] Re-run:

```bash
pytest tests/test_tables_snapshots.py -q
```

Expected: PASS.

---

## Task 3: Make Live Backend State Event-Based

**Files:**
- Modify: `hoga/live/ask_peak_state.py`
- Modify: `hoga/live/stream.py`
- Test: `tests/unit/live/test_ask_peak_state.py`
- Test: `tests/unit/live/test_stream.py`

**Interfaces:**
- Preserves: `TodayAskPeakState.ingest_orderbook(t_ms=..., asks=...)`
- Preserves: `TodayBidPeakState.ingest_orderbook(t_ms=..., bids=...)`
- Extends: `ingest_trade(..., t_ms: int | None = None, seq: int | None = None)` while accepting existing calls.
- Produces in `snapshot()`: `traded_peaks`, `untraded_peaks`, `all_peaks`, plus legacy single fields.

- [ ] Add live state tests:
  - ask wall touched by later same-price tick moves from `untraded_peaks` to `traded_peaks`.
  - ask same-price later bigger wall remains in `untraded_peaks` when no later tick reaches it.
  - bid mirrors the same behavior with `<=`.
  - prior trade does not classify a later wall.
  - `side=0` trade is ignored.
  - `snapshot()` includes `untraded_peaks` and legacy single `untraded_*` fields.
- [ ] Add stream tests proving live API payloads include ask/bid `untraded_peaks` arrays after orderbook ingestion and that continuous trade events update touched classification.
- [ ] Run:

```bash
pytest tests/unit/live/test_ask_peak_state.py tests/unit/live/test_stream.py -q
```

Expected: fail on price-set classification and missing `untraded_peaks`.

- [ ] Replace `observed_price_peaks: dict[int, Peak]` with event storage that can retain repeated same-price wall events at different times.
- [ ] Extend `Peak` with `seq: int | None = None`. Pass stream sequence when available; pass `None` from current call sites that only expose `t_ms`. Keep JSON snapshots to `price`, `qty`, `t_ms`.
- [ ] Keep `traded_prices` in snapshots only as compatibility/debug output. Do not use it for wall classification.
- [ ] On `ingest_orderbook`, append/update wall events by event identity `(price, t_ms, seq, side, source)` rather than price alone. Use `_larger_peak` only for ranking, not for erasing same-price later events.
- [ ] On `ingest_trade`, ignore `side=0`; otherwise append a touch tick and reclassify existing wall events for that side.
- [ ] Ask touch predicate: later tick time/order and `trade.price >= wall.price`.
- [ ] Bid touch predicate: later tick time/order and `trade.price <= wall.price`.
- [ ] `snapshot()` should rank post-touch, post-untouched, and all families by `qty DESC, t_ms ASC, price ASC`, cap emitted arrays to at least three entries, and populate legacy single fields from rank 1.
- [ ] Re-run:

```bash
pytest tests/unit/live/test_ask_peak_state.py tests/unit/live/test_stream.py -q
```

Expected: PASS.

---

## Task 4: Add Frontend Event Classifier For Today's Hooks

**Files:**
- Add: `frontend/src/live/peakWallEventClassifier.ts`
- Add: `frontend/src/live/peakWallEventClassifier.test.ts`
- Modify: `frontend/src/live/useDayAskPeaks.ts`
- Modify: `frontend/src/live/useDayBidPeaks.ts`
- Test: `frontend/src/live/useDayAskPeaks.test.tsx`
- Test: `frontend/src/live/useDayBidPeaks.test.tsx`

**Interfaces:**
- Produces: `classifyAskWallEvents(events, trades)` and `classifyBidWallEvents(events, trades)`.
- Produces: ranked `postTouch`, `postUntouched`, and `all` arrays using `AskPeakCandidate` shape.
- Removes: candle OHLC/range coverage as a post-touch classifier.

- [ ] Write `peakWallEventClassifier.test.ts` covering ask/bid crossing inequalities, repeated same-price split, prior trade ignored, `side=0` ignored, and rank ordering.
- [ ] Update hook tests so today's live orderbook/trade inputs reproduce the user's example:
  - first same-price wall touched later appears in `traded_peaks`.
  - later larger same-price wall not touched later appears in `untraded_peaks`.
- [ ] Update or remove tests that expect candle range coverage to classify a wall as traded. Tick data is now the classifier.
- [ ] Run:

```bash
cd frontend && npm test -- --run src/live/peakWallEventClassifier.test.ts src/live/useDayAskPeaks.test.tsx src/live/useDayBidPeaks.test.tsx
```

Expected: fail before implementation.

- [ ] Implement `peakWallEventClassifier.ts` with small pure helpers:
  - `toWallEventsFromOrderbooks(...)`
  - `toTouchTicksFromTrades(...)`
  - `classifyAskWallEvents(...)`
  - `classifyBidWallEvents(...)`
  - `rankPeakCandidates(...)`
- [ ] Treat live ordering as inclusive `trade.t_ms >= wall.t_ms` because frontend live trade/orderbook types do not expose stable `seq`.
- [ ] In `useDayAskPeaks`, use the helper for today's local orderbook/trade-derived candidates and merge backend `todayAskPeak` arrays when present.
- [ ] In `useDayBidPeaks`, mirror ask behavior.
- [ ] Keep exported hook names `useTodayAllPriceAskPeak` and `useTodayAllPriceBidPeak` for compatibility, but have their returned peak objects include `untraded_peaks` and `untraded_max_peaks`.
- [ ] Ensure old payloads without `untraded_peaks` still render rank 1 from single `untraded_*` fields.
- [ ] Re-run:

```bash
cd frontend && npm test -- --run src/live/peakWallEventClassifier.test.ts src/live/useDayAskPeaks.test.tsx src/live/useDayBidPeaks.test.tsx
```

Expected: PASS.

---

## Task 5: Render Ranked Post-Touch And Post-Untouched Families Independently

**Files:**
- Modify: `frontend/src/live/LiveAskPeakSegments.tsx`
- Modify: `frontend/src/live/LiveBidPeakSegments.tsx`
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/LivePeakWallDockedLabels.tsx`
- Modify: `frontend/src/live/peakWallVisibleCutoff.ts`
- Test: `frontend/src/live/LiveAskPeakSegments.test.tsx`
- Test: `frontend/src/live/LiveBidPeakSegments.test.tsx`
- Test: `frontend/src/live/peakWallVisibleCutoff.test.ts`
- Test: `frontend/src/live/LiveChartRoot.test.tsx`

**Interfaces:**
- Extends: `buildAskPeakOverlaySegments({ untradedRankLimit })`
- Extends: `buildBidPeakOverlaySegments({ untradedRankLimit })`
- Preserves: `allPriceRankLimit` as post-touch rank limit.
- Preserves: `showAllPrices` as post-untouched family visibility toggle.

- [ ] Add segment tests proving:
  - post-untouched rank 1 renders even when its quantity is smaller than post-touch rank 1.
  - up to three `untraded_peaks` render when `untradedRankLimit=3`.
  - post-untouched candidates render even when `traded_peaks` is empty.
  - duplicate prices are deduped within the same family after ranking, but the same price may appear once in post-touch and once in post-untouched.
  - legacy single `untraded_*` still renders when arrays are missing.
- [ ] Add cutoff tests proving `untraded_peaks` and `untraded_max_peaks` are filtered by `t_ms <= cutoff`.
- [ ] Run:

```bash
cd frontend && npm test -- --run src/live/LiveAskPeakSegments.test.tsx src/live/LiveBidPeakSegments.test.tsx src/live/peakWallVisibleCutoff.test.ts src/live/LiveChartRoot.test.tsx
```

Expected: fail on old baseline-quantity gate, single untraded line, and missing prop wiring.

- [ ] Add `untradedRankLimit?: 1 | 2 | 3` to ask and bid segment builder parameter types.
- [ ] Add helper functions that expand post-untouched candidates from `untraded_peaks` or `untraded_max_peaks`; fall back to legacy single fields only when arrays are absent or empty.
- [ ] Remove the old rule that shows an untraded line only when it is larger than the baseline post-touch line.
- [ ] Remove per-date single-untraded suppression so rank 1-3 can render for a date.
- [ ] Keep `showAllPrices=false` behavior: no post-untouched family renders.
- [ ] Extend `filterPeakByVisibleCutoff` or equivalent cutoff helpers to filter `untraded_peaks` and `untraded_max_peaks`.
- [ ] Read `askPeakUntradedRankLimit` and `bidPeakUntradedRankLimit` in `LiveChartRoot` and `LivePeakWallDockedLabels`.
- [ ] Pass the same rank limits into chart overlays and docked-label segment derivation.
- [ ] Re-run:

```bash
cd frontend && npm test -- --run src/live/LiveAskPeakSegments.test.tsx src/live/LiveBidPeakSegments.test.tsx src/live/peakWallVisibleCutoff.test.ts src/live/LiveChartRoot.test.tsx
```

Expected: PASS.

---

## Task 6: Add UI Preferences And Config Controls

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts`
- Modify: `frontend/src/state/chartPrefs.test.ts`
- Modify: `frontend/src/live/indicators/AskPeakConfig.tsx`
- Modify: `frontend/src/live/indicators/BidPeakConfig.tsx`
- Modify: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

**Interfaces:**
- Preserves: `askPeakAllPriceRankLimit` and `bidPeakAllPriceRankLimit`, relabeled as post-touch rank limits.
- Produces: `askPeakUntradedRankLimit: 1 | 2 | 3`
- Produces: `bidPeakUntradedRankLimit: 1 | 2 | 3`

- [ ] Add preference tests asserting:
  - defaults are `askPeakUntradedRankLimit=1` and `bidPeakUntradedRankLimit=1`.
  - values `1`, `2`, `3` persist.
  - invalid values such as `0`, `4`, and non-numbers fall back to defaults.
  - existing `askPeakAllPriceRankLimit` and `bidPeakAllPriceRankLimit` still default to `1`.
- [ ] Add indicator panel tests asserting the ask and bid detail panes show:
  - `체결된 벽 표시 개수`
  - `미체결된 벽 표시 개수`
  - rank buttons `1`, `2`, `3` for each.
- [ ] Run:

```bash
cd frontend && npm test -- --run src/state/chartPrefs.test.ts src/live/indicators/IndicatorPanel.test.tsx
```

Expected: fail until prefs and controls exist.

- [ ] Add numeric preference metadata for `askPeakUntradedRankLimit` and `bidPeakUntradedRankLimit` in `frontend/src/state/chartPrefs.ts` with min `1`, max `3`, default `1`, category `indicator-modal`.
- [ ] Relabel existing `askPeakAllPriceRankLimit` and `bidPeakAllPriceRankLimit` from old `체결가격 기준` text to `체결된 벽 표시 개수`.
- [ ] Update `askPeakShowAllPrices` and `bidPeakShowAllPrices` descriptions to say they toggle `미체결된 벽`, not day-high/day-low price-membership behavior.
- [ ] In `AskPeakConfig.tsx`, render two rank controls: one bound to `askPeakAllPriceRankLimit`, one bound to `askPeakUntradedRankLimit`.
- [ ] In `BidPeakConfig.tsx`, render two rank controls: one bound to `bidPeakAllPriceRankLimit`, one bound to `bidPeakUntradedRankLimit`.
- [ ] Keep style controls separate for post-touch and post-untouched families using the existing line style preferences.
- [ ] Re-run:

```bash
cd frontend && npm test -- --run src/state/chartPrefs.test.ts src/live/indicators/IndicatorPanel.test.tsx
```

Expected: PASS.

---

## Task 7: Compatibility, Cache, And Full Regression

**Files:**
- Inspect: `hoga/api/past_indicators_cache.py`
- Inspect: `frontend/src/api/liveSeries.ts`
- Inspect: `frontend/src/live/buildLiveBundle.ts`
- Inspect: all modified files from Tasks 1-6.

- [ ] Verify Pydantic model defaults let older cached payloads without `untraded_peaks` load successfully.
- [ ] Verify frontend optional arrays let older `/api/range` and live payloads render from single `untraded_*` fields.
- [ ] Run backend focused tests:

```bash
pytest tests/test_tables_snapshots.py tests/test_api_ask_peak_model.py tests/hoga/api/test_bundle.py tests/unit/live/test_ask_peak_state.py tests/unit/live/test_stream.py -q
```

Expected: PASS.

- [ ] Run frontend focused tests:

```bash
cd frontend && npm test -- --run src/live/peakWallEventClassifier.test.ts src/live/useDayAskPeaks.test.tsx src/live/useDayBidPeaks.test.tsx src/live/LiveAskPeakSegments.test.tsx src/live/LiveBidPeakSegments.test.tsx src/live/peakWallVisibleCutoff.test.ts src/state/chartPrefs.test.ts src/live/indicators/IndicatorPanel.test.tsx src/live/LiveChartRoot.test.tsx
```

Expected: PASS.

- [ ] Run frontend type/build check:

```bash
cd frontend && npm run build
```

Expected: PASS.

- [ ] Run full backend test suite if focused tests pass:

```bash
pytest -q
```

Expected: PASS.

- [ ] Run git diff review:

```bash
git diff -- hoga/tables/snapshots.py hoga/api/models.py hoga/api/bundle.py hoga/live/ask_peak_state.py hoga/live/stream.py frontend/src/api/types.ts frontend/src/live frontend/src/state/chartPrefs.ts tests frontend/src/state/chartPrefs.test.ts
```

Expected: diff shows event-based classifier, ranked post-untouched arrays, UI rank controls, and no unrelated rewrites.

---

## Manual Verification

- [ ] Start the app with the repository's normal backend/frontend development commands.
- [ ] Open `/live`.
- [ ] Enable `당일 매도 최대벽`.
- [ ] Set `체결된 벽 표시 개수` to `3`.
- [ ] Set `미체결된 벽 표시 개수` to `3`.
- [ ] Confirm up to three post-touch ask walls and up to three post-untouched ask walls can render with their separate styles.
- [ ] Repeat the same checks for `당일 매수 최대벽`.
- [ ] In a captured/replayable day matching the same-price example, confirm the earlier touched wall appears in the post-touch family and the later untouched wall appears in the post-untouched family.
- [ ] Enable `보이는 최신 봉 기준`, scroll before a later touch tick, and confirm that wall remains post-untouched as of the cutoff.
- [ ] Open the same symbol/view in `/study` and confirm behavior matches `/live`.

---

## Risk Notes

- Historical SQL can become expensive if every wall event joins every later tick. If focused tests pass but performance is poor on real captured days, replace correlated `EXISTS` with a DuckDB suffix max/min tick index. The observable contract stays the same.
- Live state can grow if every level event is retained for the whole day. Keep emitted arrays capped, but preserve enough same-price event history to distinguish post-touch and post-untouched rank 1-3.
- `체결된 벽` is UI shorthand. Code comments and docs should prefer post-touch language so the product does not imply order-ID-level fill certainty.
- The old day-high/day-low definition of `untraded_*` is superseded. Tests should explicitly guard against accidentally reintroducing it.

---

## Completion Criteria

- Same-price earlier/later wall events can classify differently in backend historical queries and live state.
- Ask and bid use side-aware crossing rules.
- `side=0` ticks never classify walls as post-touch.
- `untraded_peaks` and `untraded_max_peaks` are present on backend rows, API models, TypeScript types, live payloads, and rendered segment inputs.
- UI exposes rank 1-3 controls for both `체결된 벽` and `미체결된 벽`, for both ask and bid.
- Focused backend tests, focused frontend tests, frontend build, and full backend tests pass.
