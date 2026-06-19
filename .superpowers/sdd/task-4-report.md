# Task 4 Report

## What changed

- Added `tests/api/test_app_startup_scheduler.py` to cover the FastAPI lifespan startup regression.
- Kept the app startup path unchanged after verification; the final diff is test-only.

## Verification

### Targeted pytest

Command:

```bash
uv run --extra dev pytest \
  tests/test_api_scheduler.py \
  tests/test_api_watchlist_routes.py \
  tests/api/test_app_startup_scheduler.py \
  tests/api/test_screener_update.py \
  tests/api/test_screener_run_update.py \
  tests/unit/live/test_lifecycle_start.py \
  -q
```

Result:

- `81 passed`

### Smoke: default startup

Command:

```bash
timeout 10s uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8018 --reload-dir hoga
```

Result:

- `Application startup complete` was present.
- Exit code `124` after startup, treated as timeout-after-startup.
- Unexpected log still present: `calendar: KIS trading-day fetch failed ... chk-holiday call failed ...`
- Expected absent strings observed absent: `watchlist-catchup`, `catch-up:`, `KIS rate-limited (EGW00201)`

### Smoke: opt-in startup catch-up

Command:

```bash
HOGA_STARTUP_CATCHUP_ENABLED=true timeout 10s uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8019 --reload-dir hoga
```

Result:

- `Application startup complete` was present.
- Exit code `124` after startup, treated as timeout-after-startup.
- Catch-up logs were present, including `catch-up failed for ...`, which matches the opt-in path.

## Concern

- The default boot smoke still emits the calendar fetch warning above. I did not expand the fix beyond the Task 4 regression test scope.
