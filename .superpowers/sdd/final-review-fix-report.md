## 2026-06-24 Final review fixes

- Fixed the initial `/study?view=...` deep-link race by deferring study-route rewrites until the first query seed finishes resolving, so a persisted active tab cannot clobber the incoming URL before saved views load.
- Registered the study drop target for the empty/loading/error study shells as well as the loaded snapshot shell, preserving the snapshot-only `/study` data path while making `isPointOnStudy(...)` available across the page lifecycle.
- Wired saved-view stock-group drag start/move/cancel in `StudyViewsDrawer` so group drags update `overStudy`, show the study hover path during drag, and still open the newest save on drop without disturbing watchlist or screener drag behavior.

### Tests

- `cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx src/studyViews/StudyViewsDrawer.test.tsx`
- `cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx src/studyViews/StudyViewsDrawer.test.tsx src/state/entryDrag.test.ts src/watchlist/WatchlistDrawer.drag.test.tsx src/screener/ScreenerDrawer.test.tsx`

Results: 5 files passed, 95 tests passed.
