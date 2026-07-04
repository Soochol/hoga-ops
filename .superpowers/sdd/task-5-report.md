# Task 5 Report: REST Bypass Degradation for Quotes, Screener, and Investor Paths

## Scope

Implemented Task 5 only: quote, tab-metrics, screener intraday, and investor-related REST paths now degrade without KIS REST/capacity calls when `kis_rest_bypass_enabled` is true.

## TDD Evidence

### RED

Command:

```bash
./.venv/bin/python -m pytest tests/unit/live/test_api_kis_rest_bypass_quotes.py tests/api/test_screener_runner.py -q
```

Result: `5 failed, 3 passed in 0.30s`

Expected failures:

- `/api/live/quotes` returned 500 because bypass still reached `run_with_capacity`.
- `/api/live/tab-metrics` returned 500 because bypass still reached quote capacity scheduling.
- Investor routes returned 500 because bypass still reached capacity scheduling.
- Screener intraday scan still called `build_intraday_overlay`.

### GREEN

Command:

```bash
./.venv/bin/python -m pytest tests/unit/live/test_api_kis_rest_bypass_quotes.py tests/api/test_screener_runner.py -q
```

Result: `8 passed in 0.31s`

## Verification

Commands:

```bash
./.venv/bin/python -m pytest tests/unit/live/test_api_kis_rest_bypass_quotes.py tests/unit/api -k intraday -q
./.venv/bin/python -m pytest tests/unit/live/test_live_quotes_route.py tests/unit/live/test_live_quote_fetcher.py -q
./.venv/bin/python -m pytest tests/unit/live/test_api.py -k "past_investor_net or investor_trend_estimate or index_investor_net" -q
./.venv/bin/python -m pytest tests/api/test_live_indices_routes.py tests/unit/live/test_live_index_investor_net.py tests/unit/live/test_live_investor_net_backfill.py tests/unit/live/test_api_kis_rest_bypass_candles.py tests/unit/live/test_kis_rest_bypass_access.py -q
./.venv/bin/python -m pytest tests/unit/live/test_api_kis_rest_bypass_quotes.py tests/api/test_screener_intraday.py tests/api/test_screener_runner.py -q
./.venv/bin/python -m ruff check hoga/api/screener_intraday.py tests/unit/live/test_api_kis_rest_bypass_quotes.py
```

Results:

- `1 passed, 136 deselected in 0.11s`
- `33 passed in 0.83s`
- `15 passed, 92 deselected in 0.45s`
- `21 passed in 0.46s`
- `13 passed in 0.26s`
- `All checks passed`

Note: the literal `tests/unit/api -k intraday` selector only matches an unrelated unit/API test in this repository. Actual screener intraday coverage lives under `tests/api/test_screener_intraday.py` and `tests/api/test_screener_runner.py`, so those were run explicitly.

## Files Changed

- `hoga/live/api.py`
- `hoga/api/screener_intraday.py`
- `hoga/api/screener_runner.py`
- `tests/unit/live/test_api_kis_rest_bypass_quotes.py`
- `tests/unit/live/test_live_quotes_route.py`
- `tests/api/test_screener_runner.py`
- `.superpowers/sdd/task-5-report.md`

## Implementation Details

- Added `LiveQuote.stale` and `LiveQuote.stale_reason`.
- Added `LiveQuoteFetcher.stale_last_good()` for bypass responses from the in-process last-good quote cache.
- `/api/live/quotes` returns stale last-good quotes under bypass, or an empty array when no last-good quote exists.
- `/api/live/tab-metrics` skips quote enrichment under bypass and keeps hoga-derived metrics.
- Screener intraday overlay is skipped under bypass and emits `kis_rest_bypassed_intraday_overlay_skipped` plus the EOD fallback warning.
- `/api/live/investor-trend-estimate` returns an explicit empty error response with `data_warning.reason == "kis_rest_bypassed"`.
- `/api/live/past-investor-net` serves cache-only data with `kis_rest_bypassed` gap warnings.
- `/api/live/index-investor-net` returns empty points with a `kis_rest_bypassed` warning.

## Commit

- Commit message: `feat: degrade quote and screener REST paths during bypass`

## Concerns

- No frontend files were changed.
- KIS candle paths were not changed.
- Screener scan bypass wiring lives in `hoga/api/screener_runner.py` in this repo, so that file was changed even though the brief named `hoga/api/screener.py`.
