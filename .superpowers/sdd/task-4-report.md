# Task 4 Report: Rest30sRecorder Policy Migration

## Scope

Implemented only Task 4 in:

- `hoga/live/rest30_recorder.py`
- `tests/unit/live/test_rest30_recorder.py`

Did not modify `ProgramTradeCollector` or any backfill route.

## TDD Evidence

### RED

Command:

```bash
/home/dev/code/hoga-ops/.venv/bin/python -m pytest tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_logs_transport_failures_without_traceback tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_rate_limit_does_not_supervisor_backoff tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_unexpected_failures_keep_traceback -q
```

Result:

- Exit code: `1`
- `3` tests failed as expected
- Failures showed:
  - transport log message missing `kind=transport`
  - rate-limit path still skipped the second poll due to supervisor backoff
  - unexpected error log message missing `kind=unexpected error=RuntimeError`

### GREEN

Command:

```bash
/home/dev/code/hoga-ops/.venv/bin/python -m pytest tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_logs_transport_failures_without_traceback tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_rate_limit_does_not_supervisor_backoff tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_unexpected_failures_keep_traceback -q
```

Result:

- Exit code: `0`
- `3 passed in 0.03s`

### Full File Verification

Command:

```bash
/home/dev/code/hoga-ops/.venv/bin/python -m pytest tests/unit/live/test_rest30_recorder.py -q
```

Result:

- Exit code: `0`
- `10 passed in 0.06s`

## Implementation Summary

- Migrated `Rest30sRecorder` to shared live error policy helpers:
  - `classify_live_error`
  - `format_live_error`
- Added additive `Rest30sStatus` fields:
  - `last_error_kind`
  - `last_error_code`
  - `backoff_remaining`
- Tracked `_last_error_kind` and `_last_error_code` on the recorder instance.
- Cleared error kind/code on no-target cycles.
- Marked unavailable KIS client as:
  - `last_error_kind="auth"`
  - `last_error_code="kis_unavailable"`
- Applied policy-driven logging:
  - warning without traceback for policy cases that suppress traceback
  - error with traceback for unexpected failures
- Applied policy-driven backoff:
  - transport errors keep supervisor backoff
  - rate-limit errors do not add supervisor backoff because policy backoff is `0`

## Commit

Created commit:

- `feat: apply error policy to rest30 recorder`

## Task 4 Review Fix: Rest30sStatus Compatibility

### Fix

- Made the newly added `Rest30sStatus` fields backward-compatible by adding defaults:
  - `last_error_kind: str | None = None`
  - `last_error_code: str | None = None`
  - `backoff_remaining: int = 0`
- Reordered the dataclass fields to keep `Rest30sStatus` constructible without those arguments while preserving existing status data population semantics.

### Validation

Ran required targeted test command:

```bash
/home/dev/code/hoga-ops/.venv/bin/python -m pytest tests/unit/live/test_rest30_recorder.py tests/unit/live/test_lifecycle_rest30_recorder.py -q
```

Result:

- Exit code: `0`
- `12 passed`
