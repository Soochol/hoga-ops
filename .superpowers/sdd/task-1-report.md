Task 1 implemented: startup catch-up env boundary helper.

- Added tests:
  - `test_startup_catchup_enabled_defaults_to_false`
  - `test_startup_catchup_enabled_accepts_true_only`
- Added `startup_catchup_enabled_from_env()` in `hoga/api/scheduler.py` returning
  `True` only for `HOGA_STARTUP_CATCHUP_ENABLED=true`.
- Verified via pytest:
  - `uv run --extra dev pytest tests/test_api_scheduler.py::test_startup_catchup_enabled_defaults_to_false tests/test_api_scheduler.py::test_startup_catchup_enabled_accepts_true_only -q`
- Current `start_scheduler` behavior remains unchanged in this task (Task 2 to gate spawn remains pending).
