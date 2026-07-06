# Task 1 Report: Pure Profile Module

## Completed
- Added `frontend/src/live/indicators/indicatorPaneProfiles.test.ts`.
- Added `frontend/src/live/indicators/indicatorPaneProfiles.ts`.
- Implemented:
  - `IndicatorPaneProfileKey`, `IndicatorPanePrefs`, `PanePrefKey`, `IndicatorPanePrefsByTimeframe`
  - `profileKeyForTimeframe`
  - `normalizePanePrefsByTimeframe`
  - `legacyPanePrefsFromIndicators`
  - `panePrefsForTimeframe`
  - `resolvePaneTogglesForTimeframe`

## TDD verification
1. Added tests (RED intent) in new test file.
2. Ran test command:
   - `cd frontend && npm test -- --run src/live/indicators/indicatorPaneProfiles.test.ts`
   - Initially failed because `vitest` was not installed in workspace.
3. Installed frontend deps via `cd frontend && npm install`.
4. Re-ran the same test command and got:
   - `1 passed | 6 tests`
5. Also ran `cd frontend && npm run build` for a type/build sanity check:
   - passed.

## Result
- Task 1 implemented successfully with only the two requested files touched.

## Concerns
- Existing `mergeLiveIndicatorPrefs` does not currently preserve a `panePrefsByTimeframe` payload, so the override-path tests construct the indicator object by spreading merge output plus `panePrefsByTimeframe` for runtime validation.
