Status: DONE

Task: Verify Central KIS REST Gate Coverage

Scope:
- Added endpoint-parametrized central bypass coverage to `tests/unit/live/test_kis_rest_bypass_access.py`.
- No production code changed; `kis_access.run_with_capacity()` already blocks before scheduler execution for the tested endpoints.

Changes:
- Added `test_run_with_capacity_blocks_representative_endpoints_when_bypass_on`.
- The test covers representative endpoints:
  - `PAST_MINUTE`
  - `PAST_DAILY`
  - `QUOTES`
  - `LIVE_ORDERBOOK`
  - `LIVE_TRADES`
  - `LIVE_BROKERS`
  - `INVESTOR_NET`
- For each endpoint, the test enables `kis_rest_bypass_enabled`, calls `run_with_capacity()`, expects `KisRestBypassedError`, and asserts the scheduler was not called.

Verification:
- Implementer run:
  - `uv run --extra dev pytest tests/unit/live/test_kis_rest_bypass_access.py -q`
  - `10 passed`
- Implementer run:
  - `uv run --extra dev pytest tests/unit/live/test_api_kis_rest_bypass_quotes.py tests/unit/live/test_kis_rest_bypass_access.py -q`
  - `14 passed`

Files Changed:
- `tests/unit/live/test_kis_rest_bypass_access.py`

Commit:
- `fcd9a660 test(live): broaden KIS REST bypass gate coverage`

Concerns:
- None.
