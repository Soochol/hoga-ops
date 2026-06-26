Task 2 report

Status: DONE

Summary:
- Added `BrokerLateEntryEvent` to the API wire models and exposed `RangeBundle.broker_late_entries`.
- Wired `/api/range` to accept `broker_late_entry_start_hhmm`, validate `900..1520`, and thread it into `build_range_bundle`.
- Added `build_broker_late_entries_slice()` in `hoga/api/bundle.py` to query broker late-entry events and convert native HHMMSSmmm timestamps to Unix ms.
- Updated range tests for the new field/validation and adjusted broker-series expectation to remove the API-level top-10 cap assumption.
- Kept route-level test doubles in sync with the new range builder signature.

TDD evidence:
1. Red:
   - `uv run --extra dev pytest tests/test_api_range.py::test_range_accepts_broker_late_entry_threshold_and_returns_field tests/test_api_range.py::test_range_rejects_invalid_broker_late_entry_threshold -q`
   - Result: 2 failing tests (`broker_late_entries` missing, invalid threshold still returned 200).
2. Green:
   - Same targeted command after implementation.
   - Result: 2 passed.
3. Full verification:
   - `uv run --extra dev pytest tests/test_tables_brokers.py tests/test_api_brokers_series.py tests/test_api_range.py -q`
   - Result: 42 passed.

Files changed:
- `hoga/api/models.py`
- `hoga/api/bundle.py`
- `hoga/api/routes.py`
- `tests/test_api_range.py`
- `tests/test_api_brokers_series.py`

Concerns:
- None.

## Task 2 Fix Report

Summary:
- Defaulted `/api/range` and `build_range_bundle()` to `broker_late_entry_start_hhmm=930`, so omitted params still flow through the broker late-entry slice while explicit invalid values still return 400.
- Added a range route test that proves the omitted query param uses the default `930` path and still returns `broker_late_entries`.
- Replaced the tautological broker-series length assertion with response shape, source, ordering, and timestamp checks.
- Updated mocked range slice tests to stub `build_broker_late_entries_slice()` now that the default path is always active.

Test command:
- `uv run --extra dev pytest tests/test_tables_brokers.py tests/test_api_brokers_series.py tests/test_api_range.py -q`

Test result:
- Passed: `43 passed in 0.60s`
