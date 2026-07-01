## Task 1 Report

Status: DONE

Scope completed:
- Implemented the pure helper interface and functions in `frontend/src/chart/AskPeakSegmentsPrimitive.ts`:
  - Added/exported `PeakWallDockedLabel`
  - Added/exported `livePeakWallDockedLabelsFromSegments`
  - Added/exported `inlinePeakWallSegmentsForDocking`
- Exported constants exactly as requested:
  - `PEAK_DOT_RADIUS_PX`, `LABEL_GAP_PX`, `LABEL_FONT_PX`, `LABEL_ROW_GAP_PX`, `LABEL_EDGE_PAD_PX`, `LABEL_SEGMENT_PAD_PX`, `LABEL_BOX_X_PAD_PX`, `LABEL_BOX_Y_PAD_PX`
- Appended focused tests to `frontend/src/chart/AskPeakSegmentsPrimitive.test.ts` for:
  - `livePeakWallDockedLabelsFromSegments`
  - `inlinePeakWallSegmentsForDocking`

TDD RED evidence:
- Command: `cd frontend && npm test -- AskPeakSegmentsPrimitive.test.ts`
- Failure (expected): two helper tests failed because helper exports were absent (`TypeError: ... is not a function`).

TDD GREEN evidence:
- Command: `cd frontend && npm test -- AskPeakSegmentsPrimitive.test.ts`
- Result: `Test Files  1 passed (1), Tests 7 passed (7)`.

Commit:
- `feat: split live peak wall labels`
