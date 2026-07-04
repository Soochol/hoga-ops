# Task 2 Report: Central KIS REST Access Guard

## Status

Completed.

## What Changed

- Added `KisRestBypassedError(KisApiError)` in [hoga/live/kis_access.py](/home/dev/.codex/worktrees/2486/hoga-ops/hoga/live/kis_access.py).
- Added `kis_rest_bypass_enabled(data_dir: Path) -> bool` plus internal `_raise_if_bypassed(...)`.
- Guarded both REST access seams before any client/scheduler work:
  - `run_with_capacity(...)` now raises immediately when bypass is enabled.
  - `fetch_for_role(...)` now raises immediately when bypass is enabled.
- Added focused unit coverage in [tests/unit/live/test_kis_rest_bypass_access.py](/home/dev/.codex/worktrees/2486/hoga-ops/tests/unit/live/test_kis_rest_bypass_access.py) for:
  - scheduler path blocked before submit
  - legacy fallback path blocked before client resolution
  - scheduler path still allowed when bypass is off

## TDD Record

1. Wrote `tests/unit/live/test_kis_rest_bypass_access.py` first.
2. Ran red phase with `uv run pytest tests/unit/live/test_kis_rest_bypass_access.py -q`.
3. Verified expected failure: missing `kis_access.KisRestBypassedError`.
4. Implemented minimal guard in `hoga/live/kis_access.py`.
5. Ran green verification:
   - `uv run pytest tests/unit/live/test_kis_rest_bypass_access.py tests/unit/live/test_kis_runtime_accounts.py::test_kis_for_role_n1_all_account0 -q`
   - Result: 4 passed.

## Notes

- The brief’s example used bare `pytest`, but this workspace required `uv run pytest` because the direct `pytest` entrypoint lacked the module environment.
- Per instructions, unrelated uncommitted docs/spec/plan changes were left untouched and unstaged.

## Commit

- `feat: block KIS REST data calls when bypassed`

## Concerns

- None from this task’s scope.

## Follow-up Fix

- Review found that the legacy fallback bypass test monkeypatched `kis_for_role` without proving it was never called.
- Updated `test_run_with_capacity_blocks_legacy_fallback_when_bypass_on` to install a sentinel side effect and assert `kis_for_role_called is False` when bypass is enabled.
- Re-ran the requested focused suite:
  - `uv run pytest tests/unit/live/test_kis_rest_bypass_access.py tests/unit/live/test_kis_runtime_accounts.py::test_kis_for_role_n1_all_account0 -q`
  - Result: 4 passed.
