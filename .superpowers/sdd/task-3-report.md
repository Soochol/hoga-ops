# Task 3 Report

## What changed

- Added pure visible-cutoff helper logic in `frontend/src/live/peakWallVisibleCutoff.ts`.
- Added helper TDD coverage in `frontend/src/live/peakWallVisibleCutoff.test.ts`.
- Threaded `visibleTimeCutoff` through ask and bid overlay builders.
- Clipped cutoff-date ranked candidate arrays before overlay expansion so post-cutoff candidates cannot re-enter baseline ranking.
- Added ask overlay regression coverage in `frontend/src/live/LiveAskPeakSegments.test.tsx`.
- Created bid overlay regression coverage in `frontend/src/live/LiveBidPeakSegments.test.tsx`.

## TDD RED/GREEN evidence

### RED 1: helper missing

Command:

```bash
cd frontend
npm test -- --run src/live/peakWallVisibleCutoff.test.ts
```

Result:

- Failed suite.
- Error: `Failed to resolve import "./peakWallVisibleCutoff"` because the file did not exist.

### GREEN 1: helper implemented

Command:

```bash
cd frontend
npm test -- --run src/live/peakWallVisibleCutoff.test.ts
```

Result:

- `Test Files 1 passed`
- `Tests 4 passed`

### RED 2: overlay still leaked post-cutoff candidate

Command:

```bash
cd frontend
npm test -- --run src/live/LiveAskPeakSegments.test.tsx src/live/LiveBidPeakSegments.test.tsx
```

Result:

- Ask overlay regression failed.
- Expected one segment before cutoff, received two.
- After partial integration, ask regression still failed with baseline candidate `{ price: 101, qty: 900 }` surviving past cutoff.

### GREEN 2: helper + overlay integration complete

Command:

```bash
cd frontend
npm test -- --run src/live/peakWallVisibleCutoff.test.ts src/live/LiveAskPeakSegments.test.tsx src/live/LiveBidPeakSegments.test.tsx
```

Result:

- `Test Files 3 passed`
- `Tests 35 passed`

## Tests run with results

1. `cd frontend && npm test -- --run src/live/peakWallVisibleCutoff.test.ts`
   - First run: failed as expected because helper module did not exist.
   - Second run: passed, `4/4` tests.
2. `cd frontend && npm test -- --run src/live/LiveAskPeakSegments.test.tsx src/live/LiveBidPeakSegments.test.tsx`
   - Failed during red phase on the new ask visible-cutoff regression.
3. `cd frontend && npm test -- --run src/live/peakWallVisibleCutoff.test.ts src/live/LiveAskPeakSegments.test.tsx src/live/LiveBidPeakSegments.test.tsx`
   - Passed, `35/35` tests.

## Files changed

- `frontend/src/live/peakWallVisibleCutoff.ts`
- `frontend/src/live/peakWallVisibleCutoff.test.ts`
- `frontend/src/live/LiveAskPeakSegments.tsx`
- `frontend/src/live/LiveAskPeakSegments.test.tsx`
- `frontend/src/live/LiveBidPeakSegments.tsx`
- `frontend/src/live/LiveBidPeakSegments.test.tsx`

## Self-review findings

- The helper stays pure and reusable: one function derives the visible cutoff, one applies it to peak collections.
- Ask and bid overlay builders now consume the same cutoff helper instead of open-coding side-specific filtering.
- I added symmetric gating for today all-price bid candidates so today-only overlays cannot bypass the visible cutoff on the bid side.
- No additional issues found in the scoped files after diff review.

## Concerns

- `LiveChartRoot` wiring is intentionally not included yet, per Task 3 scope.
