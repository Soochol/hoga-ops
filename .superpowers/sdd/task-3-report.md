# Task 3 Report: Bound Today Live State Classification

## What changed
- Converted `TodayAskPeakState` / `TodayBidPeakState` to a bounded lifecycle model for live peaks.
- Added `open_by_price`, `closed_traded`, and `all_best_by_price_time` to track current open walls, touched walls, and best-per-price-time entries.
- Kept `observed_peak_events` populated as a compatibility mirror, but snapshot ranking now comes from the bounded lifecycle state.
- Preserved the public method names and snapshot payload shape.
- Added a regression test for same-price collapse and reopen behavior, and updated the legacy seq-touch tests to seed the new open-state path directly.

## Tests and results
- RED check: `uv run pytest tests/unit/live/test_ask_peak_state.py::test_today_state_collapses_same_price_until_touch_then_reopens -v`
  - Result: failed before the refactor, because snapshot still returned both same-price walls as open candidates.
- GREEN check: `uv run pytest tests/unit/live/test_ask_peak_state.py::test_today_state_collapses_same_price_until_touch_then_reopens -v`
  - Result: passed after the bounded-state refactor.
- Required verification: `uv run pytest tests/unit/live/test_ask_peak_state.py -v`
  - Result: passed, 13 tests passed.

## RED / GREEN evidence
- The new regression initially failed with the older event-retention behavior.
- After the refactor, the same test passed and the full live-state test file stayed green.

## Files changed
- `hoga/live/ask_peak_state.py`
- `tests/unit/live/test_ask_peak_state.py`

## Self-review findings
- The live classifier no longer rescans all stored touches against all stored walls for snapshot generation.
- Same-timestamp trade/wall cases still work, while older trades no longer leak forward into future wall classification.
- Legacy compatibility state is still present, but it is no longer the source of truth for snapshot ranking.

## Concerns
- `observed_peak_events` and `touch_ticks` remain in place for compatibility/debug coverage, so there is still some historical state kept around even though snapshot classification now uses bounded state.

---

## Review Fix 2026-07-05

### Findings fixed
- Replaced unbounded live touch/event retention with bounded state: `open_by_price` remains the current lifecycle map, `closed_traded` now retains only the top emitted traded candidates, and `observed_peak_events` / `all_best_by_price_time` are rebuilt as bounded ranked caches instead of raw history.
- Restored seq-aware touch ordering through `_touch_is_after_wall` semantics for both live trade closure of open walls and the same-ms back-classification fallback used during orderbook ingest.
- Removed dependence on unbounded `touch_ticks`; same-ms fallback now keeps only the latest touched millisecond summary plus the latest seq-aware touch for that millisecond.

### Tests and results
- `uv run pytest tests/unit/live/test_ask_peak_state.py -v`
  - Result: passed, 15 passed in 0.06s.
- Added regression coverage for:
  - same-price churn collapsing into one traded lifecycle before reopen
  - same-ms earlier-seq trade not touching a later-seq wall through the internal fallback path
  - bounded `closed_traded`, `observed_peak_events`, and `all_best_by_price_time` lengths after many closes

### Files changed
- `hoga/live/ask_peak_state.py`
- `tests/unit/live/test_ask_peak_state.py`

### Self-review
- Snapshot payload shape and public ingest APIs are unchanged.
- The bounded caches are sufficient for current snapshot ranking because closed state only needs the emitted top-N, while current open lifecycles remain price-bounded in `open_by_price`.
- Same-ms seq-aware fallback is intentionally conservative: when a wall seq is available, it only classifies from the latest seq-aware touch kept for that millisecond, which avoids the reviewed false-positive case without reintroducing unbounded replay state.
