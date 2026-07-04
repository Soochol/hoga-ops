# Task 4 Report: Cache-Only Candle and Index Endpoints

## Scope

Implemented Task 4 only:

- `hoga/live/live_candle_backfill.py`
- `hoga/live/live_daily_candle_backfill.py`
- `hoga/live/api.py`
- `tests/unit/live/test_api_kis_rest_bypass_candles.py`

Unrelated documentation, plan, and progress files already present in the worktree were not reverted or staged.

## TDD Evidence

### RED

Command:

```bash
uv run pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q
```

Result:

- Exit code: `1`
- `3` tests failed as expected.
- Minute and daily endpoints returned `kis_api_error` instead of `kis_rest_bypassed`.
- Index daily endpoint returned HTTP 500 under bypass.

### GREEN

Command:

```bash
uv run pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q
```

Result:

- Exit code: `0`
- `4 passed in 0.15s`
- Tests assert bypass responses return HTTP 200, first warning reason is `kis_rest_bypassed`, `kis_access.run_with_capacity` is not called, and fake KIS fetch counts stay at 0.

## Implementation Summary

- Added `LiveMinuteCandleBackfill.collect_minute_cache_only`.
  - Reads past disk cache and today memory cache only.
  - Returns cached rows, empty `fresh_dates`, existing response shape, and per-date `kis_rest_bypassed` warnings for misses.
- Added `LiveDailyCandleBackfill.collect_daily_cache_only`.
  - Reads daily batch cache and today memory cache only.
  - Computes uncovered gaps and emits `kis_rest_bypassed` batch warnings.
  - Preserves `cached_batches`, `fresh_batches`, `venue`, and candle sorting/deduping.
- Added router-local cache-only builders for `/index-candles`.
  - Daily index candles read intersecting cached batches and warn for uncovered date ranges.
  - Minute index candles read exact cache hits and warn on exact misses.
- Moved bypass branches in `/past-candles`, `/past-daily-candles`, and `/index-candles` before normal REST capacity checks and fetch closures.

## Verification

Targeted Task 4 tests:

```bash
uv run pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q
```

Result: `4 passed in 0.15s`

Nearby regression tests:

```bash
uv run pytest tests/unit/live/test_api.py tests/unit/live/test_live_daily_candle_backfill.py tests/unit/live/test_index_candles_cache.py tests/unit/live/test_index_minute_candles_cache.py -q
```

Result: `118 passed in 3.19s`

New test file lint:

```bash
uv run ruff check tests/unit/live/test_api_kis_rest_bypass_candles.py
```

Result: `All checks passed!`

Whole changed-file lint was also attempted:

```bash
uv run ruff check hoga/live/api.py hoga/live/live_candle_backfill.py hoga/live/live_daily_candle_backfill.py tests/unit/live/test_api_kis_rest_bypass_candles.py
```

Result: exit code `1` due to existing broad lint findings in long-lived live modules, plus route complexity from the existing large router structure. The new test file passes lint independently.

## Concerns

- No known functional concerns.
- The live router remains large and already trips broad Ruff complexity checks; Task 4 kept changes scoped rather than refactoring that module.

## P1 Review Fix: Non-KRX Minute Bypass KRX Fallback Cache

### Finding

Non-KRX `/past-candles` bypass requests only checked the requested venue cache. Normal non-bypass fallback can store already-fetched fallback rows under KRX cache keys, so bypass needed to serve those KRX cache rows instead of warning as a miss.

### RED

Command:

```bash
uv run pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q
```

Result:

- Exit code: `1`
- `test_past_candles_bypass_uses_cached_krx_fallback_for_non_krx_request` failed with an empty `candles` response even though the KRX cache had the row.

### Fix

- Updated `LiveMinuteCandleBackfill.collect_minute_cache_only` so non-KRX policy misses try the KRX past cache before emitting `kis_rest_bypassed`.
- Applied the same fallback lookup to today memory cache misses.
- Preserved effective session venue based on the cache source, so KRX fallback rows retain KRX session metadata.
- Added regression coverage for bypass ON, `venue=NXT`, requested venue miss, KRX fallback cache hit, no miss warning for the date, no `run_with_capacity`, and no KIS fetch.

### Verification

Targeted Task 4 tests:

```bash
uv run pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q
```

Result: `5 passed in 0.18s`

Requested nearby regression tests:

```bash
uv run pytest tests/unit/live/test_api.py tests/unit/live/test_live_daily_candle_backfill.py tests/unit/live/test_index_candles_cache.py tests/unit/live/test_index_minute_candles_cache.py -q
```

Result: `118 passed in 3.13s`

## P1 Re-review Fix: Non-KRX Today Negative With KRX Today Cache

### Finding

Non-KRX `/past-candles` bypass requests still skipped cached KRX today fallback rows when the requested venue had a negative today-cache entry. The helper only checked KRX today data after requested-venue `miss`, not requested-venue `negative`.

### RED

Command:

```bash
uv run pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q
```

Result:

- Exit code: `1`
- `test_past_candles_bypass_uses_krx_today_cache_after_non_krx_negative` failed with an empty `candles` response even though requested venue had a negative today cache entry and KRX had today rows cached.

### Fix

- Updated `LiveMinuteCandleBackfill.collect_minute_cache_only` so non-KRX requested-venue today state `negative` also tries KRX today cache before treating the date as unavailable.
- Added route-level regression coverage for bypass ON, `venue=NXT`, requested-venue today negative cache, KRX today rows cached, no false miss warning, no `run_with_capacity`, and no KIS fetch.

### Verification

Targeted Task 4 tests:

```bash
uv run pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q
```

Result: `6 passed in 0.20s`

Requested nearby regression tests:

```bash
uv run pytest tests/unit/live/test_api.py tests/unit/live/test_live_daily_candle_backfill.py tests/unit/live/test_index_candles_cache.py tests/unit/live/test_index_minute_candles_cache.py -q
```

Result: `118 passed in 3.07s`
