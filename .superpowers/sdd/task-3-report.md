# Task 3 Report

Status: DONE

## Summary

Implemented the frontend slice for `연속체결 매물대 분포 (Continuous Trade Volume Distribution)`:

- added `DayVolumeDistribution` and `RangeBundle.volume_distributions`
- extended `useRange(..., options)` to optionally send `volume_distribution_bins`
- added persisted live indicator settings for enable/range-count/colors
- wired the new indicator into `IndicatorPanel`
- threaded the setting through `/live` so minute-range queries request distributions only when enabled
- extended study snapshot save/restore types so indicator settings and `volume_distributions` round-trip

## Files Changed

- `frontend/src/api/types.ts`
- `frontend/src/api/range.ts`
- `frontend/src/api/range.test.tsx`
- `frontend/src/api/studyViews.ts`
- `frontend/src/state/livePage.ts`
- `frontend/src/state/liveIndicatorsPersistence.ts`
- `frontend/src/state/liveIndicatorsPersistence.test.ts`
- `frontend/src/live/indicators/IndicatorPanel.tsx`
- `frontend/src/live/indicators/IndicatorPanel.test.tsx`
- `frontend/src/live/useLiveBundle.ts`
- `frontend/src/live/LivePage.tsx`
- `frontend/src/live/buildIndexBundle.ts`
- `frontend/src/live/buildLiveBundle.ts`
- `frontend/src/studyViews/useStudySnapshotCapture.ts`
- `frontend/src/studyViews/useStudySnapshotCapture.test.ts`
- `frontend/src/studyViews/studySnapshotAdapter.ts`
- `frontend/src/studyViews/studySnapshotAdapter.test.ts`

## TDD Notes

1. Added failing tests for:
   - `useRange` query-string behavior
   - indicator persistence defaults/normalization
   - indicator panel toggle + settings controls
   - study snapshot round-trip of settings and `volume_distributions`
2. Verified initial failure:
   - `range.test.tsx` failed because `volume_distribution_bins` was not threaded
   - persistence/panel tests failed because the new settings/category were absent
3. Implemented the minimal production changes
4. Re-ran the focused verification set until green

## Verification

Ran:

```bash
cd frontend && npm test -- range.test.tsx liveIndicatorsPersistence.test.ts IndicatorPanel.test.tsx LivePage.test.tsx useStudySnapshotCapture.test.ts studySnapshotAdapter.test.ts
```

Result:

- 6 test files passed
- 122 tests passed

## Notes

- `frontend/node_modules` was missing in this worktree, so `npm ci` was required before the requested test commands could execute.
- Kept the indicator UI in the existing category/detail-pane pattern rather than introducing a new settings surface.
