Task 2 report

Status: DONE

Files changed:
- `frontend/src/chart/PeakWallDockedLabelsPrimitive.ts`
- `frontend/src/chart/PeakWallDockedLabelsPrimitive.test.ts`

TDD Evidence:
1) RED:
- Command: `cd frontend && npm test -- PeakWallDockedLabelsPrimitive.test.ts`
- Result: failed at import resolution (`Failed to resolve import "./PeakWallDockedLabelsPrimitive"`), because the primitive file did not exist yet.

2) GREEN:
- Command: `cd frontend && npm test -- PeakWallDockedLabelsPrimitive.test.ts`
- Result: `1 passed` test file, `2 passed` tests.

3) Regression check (requested existing inline layout tests):
- Command: `cd frontend && npm test -- AskPeakSegmentsPrimitive.test.ts`
- Result: `1 passed` test file, `7 passed` tests.

Implementation summary:
- Added `PeakWallDockedLabelInput` type alias from `PeakWallDockedLabel`.
- Added `peakWallDockedLabelCandidates(...)` helper filtering empty labels and unmappable prices, producing shared right-edge candidates.
- Implemented `PeakWallDockedLabelsPrimitive` renderer, pane-view, and primitive class with chart/series wiring.
- Implemented right-docked candidate-to-layout rendering with existing `layoutAskPeakLabels` and configured label box styling constants.

Concerns:
- None.
