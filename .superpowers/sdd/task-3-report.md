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
