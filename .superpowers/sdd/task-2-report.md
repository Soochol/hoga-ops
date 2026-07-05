# Task 2 Report: Persist Profile Overrides

## Status

Completed.

## Files Changed

- `frontend/src/state/liveIndicatorsPersistence.ts`
- `frontend/src/state/liveIndicatorsPersistence.test.ts`

## TDD Record

1. Updated `frontend/src/state/liveIndicatorsPersistence.test.ts`:
   - Added `panePrefsByTimeframe: {}` to default merged baseline expectation.
   - Added three tests under `describe('mergeLiveIndicatorPrefs — 호가 토글', ...)`:
     - defaulting to `{}`.
     - preserving valid partial overrides.
     - dropping invalid payload pieces.
2. Ran focused tests (from `frontend/`): `npm test -- --run src/state/liveIndicatorsPersistence.test.ts`.
3. Updated `frontend/src/state/liveIndicatorsPersistence.ts`:
   - Added import from `../live/indicators/indicatorPaneProfiles`:
     - `normalizePanePrefsByTimeframe` (runtime)
     - `PersistedPanePrefsByTimeframe` (type-only)
   - Added `panePrefsByTimeframe: PersistedPanePrefsByTimeframe` to `PersistedIndicators`.
   - Normalized and injected `panePrefsByTimeframe` in `mergeLiveIndicatorPrefs`.
4. Re-ran the focused test file after implementation:
   - `npm test -- --run src/state/liveIndicatorsPersistence.test.ts`.

## Commit

- `2da63efe` — `feat: persist indicator pane profiles`

## Test Summary

`npm test -- --run src/state/liveIndicatorsPersistence.test.ts` from `frontend/` — PASS (40 passed).

## Import / Runtime Cycle Notes

- `normalizePanePrefsByTimeframe` is a runtime import.
- `PersistedPanePrefsByTimeframe` is type-only.
- No runtime cycle was introduced; the new import is safe because only type dependencies in `indicatorPaneProfiles.ts` touch `liveIndicatorsPersistence`.

## Concerns

None.

## Follow-up Fix (Snapshot Serialization) — 2026-07-05

### Files Changed

- `frontend/src/state/livePage.ts`

### Change

- Updated `snapshotIndicators(get)` to include `panePrefsByTimeframe: s.panePrefsByTimeframe` so the persisted indicator snapshot matches `PersistedIndicators`.

### Verification

- `cd frontend && npm run build` — PASS
- `cd frontend && npm test -- --run src/state/liveIndicatorsPersistence.test.ts` — PASS (40 passed)
