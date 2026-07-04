Status: DONE

Task: Documentation and Final Verification

Scope:
- Updated the KIS candle cache consolidation spec status to Implemented.
- Added an ADR-0040 amendment noting that the separate KIS candle endpoint remains but its cache is memory-only.
- No production code changed in this task.

Changes:
- `docs/superpowers/specs/2026-07-04-kis-candle-cache-consolidation-design.md`
  - `Status: Draft` -> `Status: Implemented`
  - Added implementation note:
    - minute KIS candle disk JSON reads/writes replaced with bounded process memory
    - KIS REST Bypass remains the central scheduled-call gate
    - existing `kis-past-candles` files are legacy artifacts and are not read by runtime cache
- `docs/adr/0040-live-candle-backfill-separate-cache.md`
  - Added `2026-07-04 Amendment: cache is memory-only`

Verification:
- Implementer run:
  - `uv run --extra dev pytest tests/unit/live/test_past_candles_cache.py tests/unit/live/test_past_daily_candles_cache.py tests/unit/live/test_live_candle_backfill.py tests/unit/live/test_live_daily_candle_backfill.py tests/unit/live/test_api_kis_rest_bypass_candles.py tests/unit/live/test_api_kis_rest_bypass_quotes.py tests/unit/live/test_kis_rest_bypass_access.py tests/unit/live/test_lifecycle_rest30_recorder.py tests/unit/live/test_lifecycle_rest_poller.py -q`
  - `69 passed`
- Implementer grep check:
  - `rg` returned `kis-past-candles` only in `tests/unit/live/test_past_candles_cache.py` plus docs note
  - no cache-read/write remnants in `hoga/live/past_candles_cache.py`

Files Changed:
- `docs/superpowers/specs/2026-07-04-kis-candle-cache-consolidation-design.md`
- `docs/adr/0040-live-candle-backfill-separate-cache.md`

Commit:
- `30a4bdc4 docs: mark KIS candle memory cache implemented`

Concerns:
- None.
