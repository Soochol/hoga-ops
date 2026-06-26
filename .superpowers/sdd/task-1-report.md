# Task 1 Report

Implemented backend broker table support for:

- `query_day_series(con, *, path) -> list[BrokerSeriesEntry]` returning all recorded brokers, sorted by absolute final net.
- `BrokerLateEntryEventRow(t_ms: int, broker: str, side: BrokerSide, net: int)`.
- `query_late_entry_events(con, *, path: Path, threshold_ms: int) -> list[BrokerLateEntryEventRow]` with native HHMMSSmmm timestamps and side-specific first-post-threshold events.

Tests added and updated in `tests/test_tables_brokers.py` to cover:

- all recorded broker series entries
- side-specific late-entry events
- the previous top-10 truncation case now returning all brokers

Verification:

- `uv run --extra dev pytest tests/test_tables_brokers.py::test_query_day_series_returns_all_recorded_brokers tests/test_tables_brokers.py::test_query_late_entry_events_are_side_specific_and_once -q`
- `uv run --extra dev pytest tests/test_tables_brokers.py -q`

Notes:

- The environment did not have a globally installed `pytest`, so I used `uv run --extra dev pytest ...` to execute the tests inside the project environment.

## Task 1 Fix Report

Fixed the late-entry broker query so it canonicalizes broker names before the final collapse step. This prevents two raw aliases for the same canonical broker on the same side and timestamp from being split into separate rows or from masking each other's net.

Test coverage added:

- a same-side, same-timestamp alias pair now collapses into one late-entry event with summed net

Verification:

- `uv run --extra dev pytest tests/test_tables_brokers.py -q`
- Result: `19 passed in 0.24s`
