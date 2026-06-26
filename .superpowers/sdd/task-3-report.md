# Task 3 Report

## Status

DONE

## Scope completed

- Added frontend wire support for `broker_late_entries` and the new `BrokerLateEntryEvent` type.
- Threaded `brokerLateEntryStartHHMM` through `useRange(...)` query key and request URL.
- Added persisted broker late-entry indicator prefs, normalization, and live-page store setters.
- Added the broker late-entry config pane and hooked it into `IndicatorPanel`.
- Passed the broker late-entry range option from `useLiveBundle` only when the indicator is enabled.

## TDD flow

1. Added failing tests to:
   - `frontend/src/state/liveIndicatorsPersistence.test.ts`
   - `frontend/src/api/range.test.tsx`
   - `frontend/src/live/indicators/IndicatorPanel.test.tsx`
2. Ran the brief's frontend test command.
3. Hit an environment blocker first: `npm test` failed because `frontend/node_modules` was absent and `vitest` was not installed on PATH.
4. Ran `npm ci` in `frontend` to restore the checked-in dependency set.
5. Re-ran the target tests and confirmed the new cases failed for the expected missing feature surface:
   - missing broker late-entry persisted fields
   - missing range query param / key threading
   - missing indicator panel UI
6. Implemented the minimal production changes to satisfy those failures.
7. Re-ran the target tests and got green.
8. Ran one extra neighboring store test file, `src/state/livePage.test.ts`, to catch persistence/snapshot omissions after the store changes.

## Files changed

- `frontend/src/api/types.ts`
- `frontend/src/api/range.ts`
- `frontend/src/state/liveIndicatorsPersistence.ts`
- `frontend/src/state/livePage.ts`
- `frontend/src/live/indicators/BrokerLateEntryConfig.tsx`
- `frontend/src/live/indicators/IndicatorPanel.tsx`
- `frontend/src/live/useLiveBundle.ts`
- `frontend/src/state/liveIndicatorsPersistence.test.ts`
- `frontend/src/api/range.test.tsx`
- `frontend/src/live/indicators/IndicatorPanel.test.tsx`

## Tests run

From `frontend/`:

```bash
npm test -- --run src/state/liveIndicatorsPersistence.test.ts src/api/range.test.tsx src/live/indicators/IndicatorPanel.test.tsx
npm test -- --run src/state/livePage.test.ts
```

Results:

- `src/state/liveIndicatorsPersistence.test.ts`: PASS
- `src/api/range.test.tsx`: PASS
- `src/live/indicators/IndicatorPanel.test.tsx`: PASS
- `src/state/livePage.test.ts`: PASS

## Notes

- The pre-existing indicator count assertion in `IndicatorPanel.test.tsx` needed to move from 13 to 14 because the new broker indicator adds one more category toggle in the left nav.
- I did not refetch on side-mode changes; only the broker late-entry start HHMM is threaded into `/api/range`, and only while the indicator is enabled, matching the task brief.

## Concerns

- None at the task-brief level.
