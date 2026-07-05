# Task 1 Report: Add Historical Classifier Unit Surface

## What changed
- Added a pure peak-wall classification surface in `hoga/tables/snapshots.py`.
- Introduced `_PeakWallEvent`, `_TradeTouch`, and `_ClassifiedPeakWalls` dataclasses.
- Added `_classify_peak_wall_events(...)` plus small sort / ranking helpers.
- Kept the existing public query functions unchanged for this task.
- Added focused unit tests in `tests/test_tables_snapshots.py` for same-price lifecycle reset behavior and best-per-price selection before touch.

## Tests and results
- Focused red-green tests:
  - `tests/test_tables_snapshots.py::test_classify_peak_wall_events_resets_same_price_after_touch`
  - `tests/test_tables_snapshots.py::test_classify_peak_wall_events_keeps_one_best_same_price_before_touch`
- Full snapshot module verification:
  - `tests/test_tables_snapshots.py`

## RED evidence
- First focused run failed as expected with:
  - `ImportError: cannot import name '_PeakWallEvent' from 'hoga.tables.snapshots'`
  - `ImportError: cannot import name '_classify_peak_wall_events' from 'hoga.tables.snapshots'`

## GREEN evidence
- Focused tests passed after implementation: `2 passed`
- Full snapshot module passed after implementation: `66 passed`

## Files changed
- `hoga/tables/snapshots.py`
- `tests/test_tables_snapshots.py`

## Self-review findings
- The helper is pure and isolated, which matches the task goal and leaves query behavior untouched.
- The classifier sorts and dedupes candidates deterministically, with same-timestamp / same-seq events counted as touched.
- The implementation is intentionally conservative and does not wire into the existing query paths yet.

## Concerns
- None for this task. Later wiring work may want to validate that the query-side lifecycle logic and this helper stay aligned.

---

# Task 1 Fix Report: Review Follow-up

## Findings fixed
- Added `side` to `_TradeTouch` and ignored invalid touch sides in the classifier so auction-side touches do not trigger wall touches.
- Corrected `_better_event` ordering to rank by highest `qty`, earliest `intra_ms`, earliest `seq`, then lowest `price`.
- Hard-capped `_classify_peak_wall_events(..., emit_limit=...)` at 3 rows.
- Filtered mixed-side `_PeakWallEvent` inputs so the classifier only uses events that match the requested side.
- Added regressions for bid touch direction, auction non-touch behavior, seq tie-break selection, rank cap, and mixed-side filtering.

## Tests and results
- Focused verification:
  - `uv run pytest tests/test_tables_snapshots.py::test_classify_peak_wall_events_resets_same_price_after_touch tests/test_tables_snapshots.py::test_classify_peak_wall_events_keeps_one_best_same_price_before_touch tests/test_tables_snapshots.py::test_better_event_uses_seq_as_tie_breaker tests/test_tables_snapshots.py::test_classify_peak_wall_events_caps_emitted_rows_at_three tests/test_tables_snapshots.py::test_classify_peak_wall_events_uses_bid_touch_direction tests/test_tables_snapshots.py::test_classify_peak_wall_events_ignores_auction_touch_side_zero tests/test_tables_snapshots.py::test_classify_peak_wall_events_ignores_mixed_side_events -v`
  - Result: `7 passed`
- Full module verification:
  - `uv run pytest tests/test_tables_snapshots.py -v`
  - Result: `71 passed`

## Files changed
- `hoga/tables/snapshots.py`
- `tests/test_tables_snapshots.py`

## Self-review
- The fix stays inside the requested scope and keeps the helper deterministic.
- The touch filter is intentionally narrow: only sides `1` and `-1` participate; everything else is ignored.
- The seq tie-break is now tested directly at the helper level because the public candidate rows do not expose `seq`.
