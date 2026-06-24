# Task 3 Report: Add Segment Metadata and Visible-Max Style Selection

## What you implemented

- Added `qty: number` metadata to `AskPeakSegment` in `frontend/src/chart/AskPeakSegmentsPrimitive.ts`.
- Updated `buildAskPeakSegments` to populate `qty` from the selected peak quantity in `frontend/src/live/LiveAskPeakSegments.tsx`.
- Added pure helper `styleVisibleMaxAskPeakSegments(segments, visibleRange, style)` in `frontend/src/live/LiveAskPeakSegments.tsx`.
- Added helper coverage in `frontend/src/live/LiveAskPeakSegments.test.tsx` for:
  - selecting exactly one visible max segment by `qty`
  - leaving styles unchanged when `visibleRange` is `null`
  - tie-breaking in favor of the first visible segment
- Added an assertion that `buildAskPeakSegments` exposes `today.qty`.
- Added `qty` to `buildBidPeakSegments` as a compile-safety follow-through because `AskPeakSegment` is shared by ask and bid segment builders.

## What you tested and test results

- Focused command from the brief:
  - `cd frontend && npx vitest run src/live/LiveAskPeakSegments.test.tsx`
- Result after implementation:
  - `Test Files  1 passed (1)`
  - `Tests  27 passed (27)`
  - exit code `0`

## TDD Evidence: RED command/output and GREEN command/output

### RED

Command:

```bash
cd frontend && npx vitest run src/live/LiveAskPeakSegments.test.tsx
```

Output excerpt:

```text
src/live/LiveAskPeakSegments.test.tsx (27 tests | 4 failed)
AssertionError: expected undefined to be 153125
TypeError: styleVisibleMaxAskPeakSegments is not a function
Test Files  1 failed (1)
Tests  4 failed | 23 passed (27)
```

### GREEN

Command:

```bash
cd frontend && npx vitest run src/live/LiveAskPeakSegments.test.tsx
```

Output:

```text
Test Files  1 passed (1)
Tests  27 passed (27)
```

## Files changed

- `frontend/src/chart/AskPeakSegmentsPrimitive.ts`
- `frontend/src/live/LiveAskPeakSegments.tsx`
- `frontend/src/live/LiveAskPeakSegments.test.tsx`
- `frontend/src/live/LiveBidPeakSegments.tsx`
- `.superpowers/sdd/task-3-report.md`

## Self-review findings

- The new helper is pure and not wired to chart viewport subscriptions yet, matching the Task 3 boundary.
- Visible-range overlap handles reversed `{ from, to }` inputs by normalizing bounds.
- Tie behavior matches the brief by only replacing the best segment on strictly greater `qty`.
- No viewport listeners, subscriptions, or store wiring were added.
- Extra bid-file touch was limited to populating required shared metadata and did not change bid selection behavior.

## Any issues or concerns

- No functional issues found in the focused scope.
- `frontend/src/live/LiveBidPeakSegments.tsx` was updated even though it was not listed in the brief, because the shared `AskPeakSegment` type now requires `qty` and leaving bid unchanged would create a type mismatch in that builder.
