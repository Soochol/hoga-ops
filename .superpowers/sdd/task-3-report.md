Status: DONE

Task: Guard Background REST Capture Under Bypass

Scope:
- Added a regression test in `tests/unit/live/test_lifecycle_rest30_recorder.py`.
- No production code changed; the existing `sync_storage_runtime()` and lifecycle behavior already satisfied the invariant once covered by the test.

Changes:
- Added `test_kis_rest_bypass_prevents_api_recorder_start`.
- The test persists `LiveSettings(storage_policy="rest_only", kis_rest_bypass_enabled=True)`.
- It starts the live stream and asserts:
  - `status.kis_rest_bypass_enabled is True`
  - `status.kis_api_targets == []`
  - `status.kis_api_running is False`
  - `FakeRest30Recorder.created == []`

Verification:
- Implementer run:
  - `uv run --extra dev pytest tests/unit/live/test_lifecycle_rest30_recorder.py tests/unit/live/test_lifecycle_rest_poller.py -q`
  - `19 passed`
- Controller verification after review clarification:
  - `uv run --extra dev pytest tests/unit/live/test_lifecycle_rest30_recorder.py tests/unit/live/test_lifecycle_rest_poller.py -q`
  - `19 passed in 0.13s`

Files Changed:
- `tests/unit/live/test_lifecycle_rest30_recorder.py`

Commit:
- `a385757f test(live): cover KIS REST bypass for REST capture runtime`

Concerns:
- None.
