Status: DONE

Task: Convert Minute Candle Cache to Memory Only

Scope:
- Updated `hoga/live/past_candles_cache.py` to use in-process storage only for past candles.
- Updated `tests/unit/live/test_past_candles_cache.py` to remove disk-cache assumptions and assert the new memory-only behavior.

Changes:
- Replaced past-cache tests with:
  - `test_past_memory_miss_then_store_then_hit_without_disk_write`
  - `test_past_cache_does_not_read_legacy_json_files`
- Removed/replaced legacy disk-specific tests for past cache:
  - `test_past_disk_miss_then_store_then_hit`
  - `test_past_corrupt_cache_treated_as_miss_and_heals_on_store`
  - `test_past_stale_cache_with_wrong_date_treated_as_miss_and_evicted`
  - `test_past_empty_cache_for_non_trading_day_is_valid`
  - `test_past_mem_with_wrong_date_evicts_and_falls_through_to_disk`
- Changed `get_past` to read only `_past_mem` and validate date via `_bars_match_date`.
- Changed `store_past` to update only `_past_mem` and LRU size.
- Changed `delete_past` to evict only `_past_mem`.
- Updated module docstring for memory-only intent and removed disk persistence imports/paths.

Verification:
- `uv run --extra dev pytest tests/unit/live/test_past_candles_cache.py -q`  
  - `13 passed in 0.08s`
- `uv run --extra dev ruff check hoga/live/past_candles_cache.py tests/unit/live/test_past_candles_cache.py`
  - `All checks passed!`

Follow-up review finding fix:
- Updated `tests/unit/live/test_api.py` at `test_past_candles_happy_path_single_date`:
  - Replaced disk-file existence assertion with memory-only assertion:
    `assert not (tmp_path / "kis-past-candles").exists()`.
- Adjusted two additional API cache-behavior tests to align with in-memory-only cache semantics:
  - `test_past_candles_rate_limit_still_serves_later_cache_hits`
  - `test_past_candles_disk_cache_survives_router_rebuild` (renamed to
    `test_past_candles_memory_cache_not_survives_router_rebuild`)

Verification:
- `uv run --extra dev pytest tests/unit/live/test_api.py -q`  
  - `107 passed in 3.51s`
- `uv run --extra dev pytest tests/unit/live/test_past_candles_cache.py tests/unit/live/test_api.py -q`
  - `120 passed in 3.20s`

Review finding follow-up:
- Fixed `tests/unit/live/test_api_kis_rest_bypass_candles.py` to match the memory-only cache seam:
  - `test_past_candles_bypass_uses_cached_krx_fallback_for_non_krx_request` now creates a seeded `PastCandlesCache` instance and monkeypatches `live_api.PastCandlesCache` before `_bypass_app()`, so the router uses the same cache instance.

Verification:
- `uv run --extra dev pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q`
  - `6 passed in 0.22s`
- `uv run --extra dev pytest tests/unit/live/test_past_candles_cache.py tests/unit/live/test_api.py tests/unit/live/test_api_kis_rest_bypass_candles.py -q`
  - `126 passed in 3.22s`
