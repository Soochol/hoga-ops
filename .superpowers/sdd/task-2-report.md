Task 2 report

Status: DONE

Summary:
- Added `LiveRestPollerStatus` and `LiveRestPoller.status()` to expose supervisor-facing state for running status, targets, last cycle timing, last error metadata, degraded state, and backoff countdown.
- Integrated `classify_live_error()` and `format_live_error()` into per-code exception handling so transport failures log as warnings without tracebacks, unexpected failures log as errors with tracebacks, and policy-driven backoff is applied locally to the REST poller.
- Added the four Task 2 regression tests covering warning/error log shape, status population, transport backoff skip behavior, and degraded-state recovery after a successful cycle.

TDD evidence:
1. Red:
   - `/home/dev/code/hoga-ops/.venv/bin/python -m pytest tests/unit/live/test_rest_poller.py::test_transport_failure_logs_warning_without_traceback_and_sets_status tests/unit/live/test_rest_poller.py::test_transport_backoff_skips_next_cycle_without_refetching tests/unit/live/test_rest_poller.py::test_unexpected_failure_logs_with_traceback_and_no_backoff tests/unit/live/test_rest_poller.py::test_successful_cycle_clears_degraded_status_after_failure -q`
   - Result: `4 failed` with the expected missing behavior: traceback-only logging, no backoff skip, and missing `LiveRestPoller.status()`.
2. Green:
   - `/home/dev/code/hoga-ops/.venv/bin/python -m pytest tests/unit/live/test_rest_poller.py::test_transport_failure_logs_warning_without_traceback_and_sets_status tests/unit/live/test_rest_poller.py::test_transport_backoff_skips_next_cycle_without_refetching tests/unit/live/test_rest_poller.py::test_unexpected_failure_logs_with_traceback_and_no_backoff tests/unit/live/test_rest_poller.py::test_successful_cycle_clears_degraded_status_after_failure -q`
   - Result: `4 passed`.
3. Full verification:
   - `/home/dev/code/hoga-ops/.venv/bin/python -m pytest tests/unit/live/test_rest_poller.py -q`
   - Result: `28 passed`.

Files changed:
- `hoga/live/rest_poller.py`
- `tests/unit/live/test_rest_poller.py`

Self-review:
- Kept the scope limited to the Task 2-owned files and did not touch lifecycle or other supervisor migrations.
- Preserved the existing `last_cycle_ms` completion semantics, including backoff-skip and resolver-`None` cycles reporting completion timestamps.
- Left unrelated workspace changes untouched, including the pre-existing modification to `.superpowers/sdd/task-1-report.md`.

Concerns:
- None.
