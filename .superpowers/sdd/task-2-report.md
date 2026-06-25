# Task 2 Report: Range API Opt-In And Bundle Generation

## Status

DONE

## Scope Completed

- Added `/api/range` support for optional `volume_distribution_bins` with FastAPI validation bounds `5..30`.
- Forwarded the opt-in parameter from `hoga/api/routes.py` into `build_range_bundle(...)`.
- Extended `build_range_bundle(...)` in `hoga/api/bundle.py` with `volume_distribution_bins: int | None = None`.
- Implemented `build_volume_distribution_slice(...)` to build per-day `DayVolumeDistribution` data from:
  - candle low/high range via `candles_tbl.query_price_range`
  - continuous-trading-only volume via `trades_tbl.query_continuous_trade_volume_distribution`
- Implemented dense bin expansion into `VolumeDistributionBin(price_low, price_high, qty)` rows.
- Ensured `/api/range` computes `volume_distributions` only when `volume_distribution_bins` is provided.
- Ensured empty bundles continue to serialize `volume_distributions: []`.

## TDD Notes

### Red

Added failing tests first:

- `tests/test_api_range.py`
  - `test_api_range_omits_volume_distribution_by_default`
  - `test_api_range_threads_volume_distribution_bins`
  - `test_api_range_rejects_invalid_volume_distribution_bins`
- `tests/hoga/api/test_bundle.py`
  - `test_build_range_bundle_volume_distributions_are_opt_in`

Observed failures:

- route did not accept or forward `volume_distribution_bins`
- invalid values were not rejected
- bundle had no opt-in volume distribution path

### Green

Implemented the route and bundle changes above, then reran focused and full target test files.

## Verification

Commands run:

```bash
.venv/bin/pytest tests/test_api_range.py tests/hoga/api/test_bundle.py -k volume_distribution -v
.venv/bin/pytest tests/test_api_range.py -v
.venv/bin/pytest tests/hoga/api/test_bundle.py -v
```

Results:

- `tests/test_api_range.py`: 14 passed
- `tests/hoga/api/test_bundle.py`: 40 passed

## Files Changed

- `hoga/api/routes.py`
- `hoga/api/bundle.py`
- `tests/test_api_range.py`
- `tests/hoga/api/test_bundle.py`

## Notes

- The implementation uses the stock-date candle low/high range as the price grid source.
- Continuous-trading-only filtering is delegated to `query_continuous_trade_volume_distribution`, which excludes `side = 0` rows.
- Existing route tests needed small test-double updates because the bundle call signature now includes `volume_distribution_bins`.

---

## Task 2 Fix: Single-Price Volume Distribution Range

### Review Finding Addressed

- Fixed `hoga/api/bundle.py` so `_expand_distribution_bins(...)` preserves the candle-derived grid on single-price days (`price_min == price_max`).
- This avoids generating `price_high` values above `price_max` and prevents the last bin from ending up with `price_high < price_low` when DuckDB's query-side zero-width guard returns `bin_width = 1`.

### Code Changes

- `hoga/api/bundle.py`
  - Added a degenerate-range branch in `_expand_distribution_bins(...)` that returns `range_count` bins with `price_low == price_high == price_min == price_max`, while preserving the sparse quantity assignment.
- `tests/hoga/api/test_bundle.py`
  - Added `test_expand_distribution_bins_single_price_day_stays_on_candle_range` as a regression test for the reviewed bug.

### Focused Verification

Commands run:

```bash
.venv/bin/pytest tests/hoga/api/test_bundle.py -k "volume_distribution or single_price_day" -v
.venv/bin/pytest tests/test_api_range.py tests/hoga/api/test_bundle.py -k volume_distribution -v
```

Observed output:

```text
tests/hoga/api/test_bundle.py::test_build_range_bundle_volume_distributions_are_opt_in PASSED
tests/hoga/api/test_bundle.py::test_expand_distribution_bins_single_price_day_stays_on_candle_range PASSED
======================= 2 passed, 39 deselected in 0.09s =======================

tests/test_api_range.py::test_api_range_omits_volume_distribution_by_default PASSED
tests/test_api_range.py::test_api_range_threads_volume_distribution_bins PASSED
tests/test_api_range.py::test_api_range_rejects_invalid_volume_distribution_bins PASSED
tests/hoga/api/test_bundle.py::test_build_range_bundle_volume_distributions_are_opt_in PASSED
======================= 4 passed, 51 deselected in 0.20s =======================
```
