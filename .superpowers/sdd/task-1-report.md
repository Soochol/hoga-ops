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
