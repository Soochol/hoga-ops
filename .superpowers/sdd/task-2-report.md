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

Follow-up fix (HiDPI docked-label gap):
- Reviewed and fixed `frontend/src/chart/PeakWallDockedLabelsPrimitive.ts` issue where `peakWallDockedLabelCandidates(...)` subtracted unscaled `LABEL_GAP_PX` while receiving bitmap-space y coordinates.
- Updated helper to accept optional `labelGapPx` parameter (default `LABEL_GAP_PX`) and used it in renderer as `LABEL_GAP_PX * vr`.
- Added focused regression test in `frontend/src/chart/PeakWallDockedLabelsPrimitive.test.ts`:
  - `supports bitmap-scaled y coordinates by taking a scaled gap`
  - Verifies yLine uses an explicit scaled gap (e.g., 6px instead of default 3px when y coordinates are bitmap-scaled).

Retest evidence:
- `cd frontend && npm test -- PeakWallDockedLabelsPrimitive.test.ts`
  - Result: `1 passed` test file, `3 passed` tests.
- `cd frontend && npm test -- AskPeakSegmentsPrimitive.test.ts`
  - Result: `1 passed` test file, `7 passed` tests.
