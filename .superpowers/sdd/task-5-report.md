# Task 5 Report: Live Wiring And Today Recompute

## Status

DONE

## What changed

1. Wired `연속체결 매물대 분포 (Continuous Trade Volume Distribution)` into `/live` sidebar rendering.
2. Threaded the active chart-side `RangeBundle` and `todayKst` into `LiveSidebar` from `LiveWorkarea`.
3. In `LiveSidebar`, derived the active stock-date profile by KST date:
   - hovered stock-date when minute spot cursor is active
   - latest segment date otherwise
4. Added a today-only recompute path that uses:
   - the active bundle's today segment session bounds
   - the active bundle's today candles for the price grid
   - live trade buffer rows flattened from `live.trade`
   - `computeContinuousTradeVolumeDistribution`
5. Kept recompute dependencies scoped to bundle/trade/settings inputs so cursor movement only changes profile selection and marker placement, not the expensive recompute memo.
6. Preserved persisted `volume_distributions` coverage and added regression tests around it.
7. Updated the existing `useLiveBundle` test expectation to match the already-present `volumeDistributionBins` query option.

## Domain behavior verified

- Only continuous-trading trades count: `side === 1 || side === -1`
- `side === 0` rows are excluded via the recompute helper
- Price grid comes from today candle low/high, not trade min/max
- Session bounds come from the per-date segment already built for the active bundle
- Persisted profile remains the fallback when today recompute is unavailable

## Files changed

- `frontend/src/live/LiveSidebar.tsx`
- `frontend/src/live/LiveWorkarea.tsx`
- `frontend/src/live/LiveSidebar.test.tsx`
- `frontend/src/live/buildLiveBundle.test.ts`
- `frontend/src/live/useLiveBundle.test.tsx`

## Verification

Ran:

```bash
cd frontend
npm test -- useLiveBundle.test.tsx buildLiveBundle.test.ts LiveSidebar.test.tsx LiveWorkarea.test.tsx
```

Result:

- `4` test files passed
- `83` tests passed
- `0` failures

## Notes

- I did not implement study detail restore; that remains Task 6 as requested.
- `useLiveBundle.ts` and `buildLiveBundle.ts` already contained the volume-distribution query option / pass-through pieces from earlier tasks, so this task focused on the missing `/live` wiring and today recompute behavior.
