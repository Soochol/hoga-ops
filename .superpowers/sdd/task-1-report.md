Status: DONE

Task: Backend Live Settings Become Partial and Persist Bypass

Implemented:
- Added `kis_rest_bypass_enabled: bool = False` to `LiveSettingsResponse`.
- Made `LiveSettingsUpdate` partial for `storage_policy`, `program_trade_storage_enabled`, and `kis_rest_bypass_enabled`.
- Updated `update_live_settings(...)` to preserve omitted fields while still forcing program-trade storage off under `ws_only`.
- Wired `/api/live/settings` PATCH to pass through `kis_rest_bypass_enabled`.
- Replaced `tests/unit/live/test_settings.py` with the brief-specified red/green coverage for default, partial patch, `ws_only`, and corrupt-file fallback behavior.

TDD record:
1. Added the new settings tests first.
2. Red: `uv run --extra dev pytest tests/unit/live/test_settings.py -q`
   - Failed for the expected reasons: missing `kis_rest_bypass_enabled` and missing partial update support.
3. Green: implemented the backend model/persistence/route changes.
4. Verification: `uv run --extra dev pytest tests/unit/live/test_settings.py tests/unit/live/test_storage_runtime.py -q`

Verification result:
- `tests/unit/live/test_settings.py`: 4 passed
- `tests/unit/live/test_storage_runtime.py`: 5 passed

Scope / constraints:
- Left existing unrelated docs/spec/plan worktree changes untouched and unstaged.
- Staged only Task 1 files for commit.

Commit:
- `feat: persist KIS REST bypass setting`

Concern:
- Existing route tests in `tests/unit/live/test_api.py` still assert the old `/api/live/settings` JSON shape and were not updated here because the task brief scoped owned files to the three backend modules plus `tests/unit/live/test_settings.py`. They may need follow-up once that task owns API test updates.

Review fix (Important):
- Updated `tests/unit/live/test_api.py` route expectations to include `kis_rest_bypass_enabled` in the `/api/live/settings` response shape.
- Added route coverage proving `PATCH /api/live/settings` can set `kis_rest_bypass_enabled` without sending `storage_policy`, preserving the partial patch contract.

Review-fix verification:
- `uv run --extra dev pytest tests/unit/live/test_api.py -q -k live_settings` -> 4 passed
- `uv run --extra dev pytest tests/unit/live/test_settings.py tests/unit/live/test_storage_runtime.py -q` -> 9 passed
