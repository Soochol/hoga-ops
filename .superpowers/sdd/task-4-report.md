Status: DONE

Task: Add Performance Guardrails

What changed:
- Added a historical classifier guardrail in `tests/test_tables_snapshots.py` covering many same-price updates before one touch. The test now asserts the classifier emits exactly one traded candidate, keeps the latest qty, and emits no untraded rows.
- Added a live-state guardrail in `tests/unit/live/test_ask_peak_state.py` covering many same-price updates before one touch. The test asserts the live state emits one traded peak, no untraded peaks, and the bounded internal state stays capped at one entry for this single-lifecycle scenario.

Tests and results:
- `uv run pytest tests/test_tables_snapshots.py::test_classify_peak_wall_events_same_price_many_updates_emit_one_per_lifecycle tests/unit/live/test_ask_peak_state.py::test_today_state_many_same_price_updates_emit_one_traded_candidate -v`
  - 2 passed
- `uv run pytest tests/test_tables_snapshots.py -k "classify_peak_wall_events" -v`
  - 7 passed
- `uv run pytest tests/unit/live/test_ask_peak_state.py -v`
  - 18 passed

Files changed:
- `tests/test_tables_snapshots.py`
- `tests/unit/live/test_ask_peak_state.py`

Self-review:
- The new coverage is narrowly scoped to the two guardrail cases in the brief.
- I checked for overlap with existing collapse and bounded-state tests before adding anything.
- No production code changes were needed.

Concerns:
- None.
