## Final review fix: memory-only candle cache wording

- Updated `hoga/live/past_daily_candles_cache.py`
  - Removed stale doc comment implying minute `PastCandlesCache` is disk-persistent.
  - Aligned wording to branch invariant: minute/day KIS caches are process-memory-only; `kis-past-candles` JSON files are legacy artifacts.
- Updated `hoga/api/past_indicators_cache.py`
  - Corrected doc wording that implied indicator cache is cached like past candles under `kis-past-candles`.
  - Clarified `kis-past-candles` files are legacy and not runtime input in this branch.
- Updated `tests/unit/live/test_api.py`
  - Renamed test: `test_past_candles_disk_cache_hit_on_second_call` -> `test_past_candles_memory_cache_hit_on_second_call`.
  - Updated stale docstring phrase from `on disk` to `in memory`.
- Updated `tests/unit/live/test_promote_today.py`
  - Reworded stale docstring comment about `~/.local/.../kis-past-candles/` to reflect memory-only runtime cache model.

## Checks

- `uv run --extra dev pytest tests/unit/live/test_api.py tests/unit/live/test_promote_today.py tests/unit/live/test_past_candles_cache.py -q`
  - Result: `128 passed`
- `git diff --check`
  - Result: clean (no whitespace/signoff issues)
