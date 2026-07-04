Task 3 Report: Stop REST Supervisors and Expose Paused Status

Summary
- Added red tests for storage runtime bypass behavior and lifecycle status/poller shutdown behavior.
- Implemented runtime suppression for REST 30s recorder and program-trade collector when `kis_rest_bypass_enabled` is on.
- Exposed `kis_rest_bypass_enabled` through lifecycle status and synchronized lifecycle state from persisted settings.
- Ensured an existing lifecycle REST poller is stopped and cleared when bypass is active, including offline refresh/start paths.

TDD Log
1. Added failing tests in:
   - `tests/unit/live/test_storage_runtime.py`
   - `tests/unit/live/test_lifecycle_rest_poller.py`
2. Ran:
   - `uv run pytest tests/unit/live/test_storage_runtime.py tests/unit/live/test_lifecycle_rest_poller.py -q`
3. Observed expected failures:
   - storage runtime still emitted REST targets under bypass
   - program trade collector kept running under bypass
   - lifecycle had no `refresh_status_from_settings`
   - existing rest poller was not stopped on bypass refresh
4. Implemented the minimal production changes in:
   - `hoga/live/storage_runtime.py`
   - `hoga/live/lifecycle.py`
5. Re-ran:
   - `uv run pytest tests/unit/live/test_storage_runtime.py tests/unit/live/test_lifecycle_rest_poller.py -q`
6. Result:
   - 23 passed

Files Changed
- `hoga/live/storage_runtime.py`
- `hoga/live/lifecycle.py`
- `tests/unit/live/test_storage_runtime.py`
- `tests/unit/live/test_lifecycle_rest_poller.py`

Notes
- The brief names `hoga/api/models.py` for `LiveStatus`, but in this codebase the active `LiveStatus` wire model is defined in `hoga/live/lifecycle.py`. I followed the existing lifecycle pattern and updated the live status model there.
- I did not stage or touch the pre-existing docs/spec/plan files outside this task report.

Commit
- `feat: pause KIS REST supervisors during bypass`
