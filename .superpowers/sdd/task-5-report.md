# Task 5 Report: ProgramTradeCollector Policy Logging and Status Codes

## TDD Evidence

### RED

Command:

```bash
/home/dev/code/hoga-ops/.venv/bin/python -m pytest tests/unit/live/test_program_trade_collector.py::test_program_trade_collector_logs_transport_without_traceback_and_sets_kind tests/unit/live/test_program_trade_collector.py::test_program_trade_collector_unexpected_errors_keep_traceback -q
```

Result: `2 failed in 0.06s`

### GREEN

Command:

```bash
/home/dev/code/hoga-ops/.venv/bin/python -m pytest tests/unit/live/test_program_trade_collector.py::test_program_trade_collector_logs_transport_without_traceback_and_sets_kind tests/unit/live/test_program_trade_collector.py::test_program_trade_collector_unexpected_errors_keep_traceback -q
```

Result: `2 passed in 0.03s`

### Full-file verification

Command:

```bash
/home/dev/code/hoga-ops/.venv/bin/python -m pytest tests/unit/live/test_program_trade_collector.py -q
```

Result: `5 passed in 0.03s`

## Files changed

- `hoga/live/program_trade_collector.py`
- `tests/unit/live/test_program_trade_collector.py`

## Implementation details

- Added `last_error_kind` and `last_error_code` to `ProgramTradeCollectorStatus`.
- Imported `classify_live_error` and `format_live_error`.
- Cleared new status fields at the start of each `run_once`.
- Replaced per-code `except Exception` handling with policy-based logging:
  - `kind=` and `code=`
  - traceback included only when `policy.include_traceback` is true
  - status fields updated for last error kind/code and count.

## Commit

- `79a27c17` — feat: apply error policy to program trade collector

## Task 5 review follow-up: stale status reset on startup failure

### Additional verification

Command:

```bash
/home/dev/code/hoga-ops/.venv/bin/python -m pytest tests/unit/live/test_program_trade_collector.py -q
```

Result: `6 passed in 0.05s`

### Regression test added

- Added `test_program_trade_collector_clears_stale_error_state_when_load_document_fails` to assert:
  - stale `last_error`, `last_error_kind`, `last_error_code`, and `last_error_count` are cleared when `load_document` raises `RuntimeError("load failed")`.

### Code change

- Moved clearing of `last_error`, `last_error_kind`, `last_error_code`, and `last_error_count` to the very top of `ProgramTradeCollector.run_once()` before `load_document(self.data_dir)`.
