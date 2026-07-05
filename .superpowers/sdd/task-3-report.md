## Task 3 Report: Store Setter And Snapshot Wiring

## Status

DONE

## Files Changed

- `frontend/src/state/livePage.ts`

## Changes

1. Added imports from `frontend/src/live/indicators/indicatorPaneProfiles`:
   - `normalizePanePrefsByTimeframe`
   - `profileKeyForTimeframe`
   - `PanePrefKey`
   - `PersistedPanePrefsByTimeframe`
2. Extended `Store` with:
   - `setPanePrefForTimeframe: (timeframe: LiveTimeframe, key: PanePrefKey, enabled: boolean) => void`
3. Implemented `setPanePrefForTimeframe` in the store object near existing pane toggles.
4. Kept existing `snapshotIndicators(get)` persistence slice including `panePrefsByTimeframe: s.panePrefsByTimeframe` intact (already present from Task 2).

## Validation

- `cd frontend && npm run build` — PASS
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
