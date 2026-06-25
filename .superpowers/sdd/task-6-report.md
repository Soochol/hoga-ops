# Task 6 Report: Study Snapshot Round-Trip

Status: DONE

## What changed

- Added the missing backend snapshot model fields for saved volume-distribution indicator state:
  - `StudyIndicatorState.volume_distribution_enabled`
  - `StudyIndicatorState.volume_distribution_range_count`
  - `StudyIndicatorState.volume_distribution_color`
  - `StudyIndicatorState.volume_distribution_max_color`
- Added the missing backend snapshot bundle field:
  - `StudySnapshotBundle.volume_distributions`
- Extended `studySnapshotDetails(...)` to carry saved volume-distribution settings and saved `volume_distributions` into study detail rendering.
- Wired `StudyDetailPanel` to render `VolumeDistributionCard` from restored snapshot data, selecting the profile by the active segment date.
- Used the active hover time when present (`cursorMs`), otherwise the active bucket start, for the card’s vertical marker.
- Kept live behavior unchanged; the new wiring is study-only and uses already-existing shared types/fields where present.

## TDD flow

1. Added backend tests for volume-distribution snapshot round-trip and indicator-state validation.
2. Added a new `StudyDetailPanel` test proving the restored study detail card:
   - picks the saved profile for the active segment date
   - ignores profiles from other dates
   - shows the cursor marker
   - uses the saved max-bar color
3. Ran the new tests first and observed the expected frontend failure (`StudyDetailPanel` was still rendering the placeholder).
4. Implemented the minimal production changes to satisfy the failing tests.
5. Re-ran the required verification commands.

## Files changed

- `/home/dev/.codex/worktrees/6352/hoga-ops/hoga/api/models.py`
- `/home/dev/.codex/worktrees/6352/hoga-ops/frontend/src/studyViews/studySnapshotAdapter.ts`
- `/home/dev/.codex/worktrees/6352/hoga-ops/frontend/src/studyViews/StudyDetailPanel.tsx`
- `/home/dev/.codex/worktrees/6352/hoga-ops/frontend/src/studyViews/StudyPage.tsx`
- `/home/dev/.codex/worktrees/6352/hoga-ops/tests/api/test_study_views.py`
- `/home/dev/.codex/worktrees/6352/hoga-ops/frontend/src/studyViews/StudyDetailPanel.test.tsx`

## Verification

- `uv run pytest tests/api/test_study_views.py -k volume_distribution -v`
  - 5 passed
- `cd frontend && npm test -- useStudySnapshotCapture.test.ts studySnapshotAdapter.test.ts StudyDetailPanel`
  - 21 passed
- Extra regression check:
  - `cd frontend && npm test -- StudyPage.test.tsx`
  - 24 passed

## Notes

- The frontend capture and adapter paths already had the `volume_distributions` round-trip in place from earlier work, so Task 6 focused on filling the remaining backend model gap and completing the restored study-detail rendering path.
- The card respects saved indicator enablement: disabled snapshots continue to show the sidebar placeholder instead of forcing the card visible.

## Review Fix Addendum

- Adjusted `StudyDetailPanel` so saved `volume_distributions` are selected from the hovered/latest segment time instead of the active candle bucket. This keeps the saved profile visible when `cursorMs` is inside a session segment but between saved candle intervals, while leaving orderbook and broker lookups bucket-based.
- Added a frontend regression in `StudyDetailPanel.test.tsx` covering a cursor positioned between saved candles inside the same segment.
- Added a backend save/load regression in `tests/api/test_study_views.py` to prove `bundle.volume_distributions` and volume-distribution indicator settings survive `create_save_sync(...)` and `load_snapshot(...)`.

### Review fix verification

- `cd frontend && npm test -- useStudySnapshotCapture.test.ts studySnapshotAdapter.test.ts StudyDetailPanel`
  - `Test Files  3 passed (3)`
  - `Tests  21 passed (21)`
- `uv run pytest tests/api/test_study_views.py -k volume_distribution -v`
  - `6 passed, 60 deselected in 0.11s`
