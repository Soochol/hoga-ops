# Task 2 Report: Backend Live Settings Storage Policy

## Status

DONE

## Scope Delivered

Implemented the backend-only live storage policy slice from the brief:

- Added persisted live settings storage in `live_settings.json`
- Added typed API models for live settings read/update payloads
- Added `GET /api/live/settings`
- Added `PATCH /api/live/settings`
- Triggered `refresh_live_stream(data_dir=...)` after successful updates
- Added focused persistence and route tests

Not implemented, per brief:

- REST recorder behavior
- source priority behavior
- frontend UI
- lifecycle target splitting

## TDD Record

### Red

Added:

- `/home/dev/.codex/worktrees/d575/hoga-ops/tests/unit/live/test_settings.py`
- two route tests appended to `/home/dev/.codex/worktrees/d575/hoga-ops/tests/unit/live/test_api.py`

Ran:

```bash
uv run pytest tests/unit/live/test_settings.py tests/unit/live/test_api.py -v
```

Observed expected failures:

- `ModuleNotFoundError: No module named 'hoga.live.settings'`
- missing `/api/live/settings` route behavior (`404` / missing `storage_policy`)

### Green

Implemented:

- `/home/dev/.codex/worktrees/d575/hoga-ops/hoga/live/settings.py`
- `LiveStoragePolicy`, `LiveSettingsResponse`, `LiveSettingsUpdate` in `/home/dev/.codex/worktrees/d575/hoga-ops/hoga/api/models.py`
- `/api/live/settings` GET/PATCH handlers in `/home/dev/.codex/worktrees/d575/hoga-ops/hoga/live/api.py`

Behavior:

- default settings: `{"schema_version": 1, "storage_policy": "ws_plus_rest"}`
- persisted file: `live_settings.json`
- invalid/corrupt settings file is renamed to `live_settings.json.corrupt-<timestamp>` and defaults are returned
- PATCH validates `storage_policy` through Pydantic literal typing
- PATCH persists the new policy and attempts `refresh_live_stream`

## Verification

Ran:

```bash
uv run pytest tests/unit/live/test_settings.py tests/unit/live/test_api.py -v
```

Result:

- `97 passed in 1.50s`

## Notes

- The brief's sample route tests were adapted to the repo's actual `build_router(...)` signature by passing `get_status=lifecycle.get_status` and `data_dir=tmp_path`, matching the current backend wiring.
- I added a small defensive `503` for `/api/live/settings` when `build_router` is constructed without `data_dir`; this does not change the Task 2 happy path and keeps bare router usage from crashing if those endpoints are called unwired.

## Commit

- `49eb7709 feat: persist live storage policy`
