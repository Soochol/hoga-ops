# Task 6 Report

## Outcome

Applied route-level surfaces across `Capture`, `Inventory`, `Screener`, `Settings`, `Study`, and `Heatmap` using the shared page-shell primitives added in earlier tasks.

## What changed

- `Capture`
  - Kept the splitter layout, added explicit page-level `PanelCard` test hooks per pane.
  - Wrapped each pane body in `DataSection` so the route now uses dense divider-based section framing instead of ad hoc inner spacing.

- `Inventory`
  - Added page-level `PanelCard` surfaces for list/detail panes.
  - Wrapped loading/empty states in the same route shell so the page stays surfaced even when data is absent.

- `Screener`
  - Converted the three-column route to one surfaced pane per column.
  - Moved the results actions into the right pane surface and replaced nested warning cards with inline states.
  - Kept the results table readable by embedding the table shell inside the pane rather than stacking another visible card.

- `Settings`
  - Kept a single route-level `PanelCard`.
  - Reorganized the body into `DataSection` blocks (`앱 정보`, `Symbol Master`, `로드맵`) to match the dense flat-section rule.

- `Study`
  - Added a route-level `PanelCard` wrapper for the active workspace.
  - Also wrapped empty/loading/error states in the same surfaced shell so `/study` follows the non-live route rule consistently.

- `Heatmap`
  - Added a route-level `PanelCard` wrapper while preserving the transparent flat folder treatment inside the board.
  - Added a stable `heatmap-board` hook for route QA/tests.

## Adjacent child-component deviations

These were the minimal child edits needed because page-level primitives alone would have created card-in-card:

- `frontend/src/inventory/StockDateGroupList.tsx`
  - Flattened the root shell so the page-level `PanelCard` owns the surface.
- `frontend/src/inventory/StockDateGroupDetail.tsx`
  - Flattened the root shell and placeholder state for the same reason.
- `frontend/src/screener/SavedScreenerList.tsx`
  - Flattened the root shell so the left route pane owns the surface.
- `frontend/src/screener/ConditionBuilder.tsx`
  - Flattened the root shell so the center route pane owns the surface.
- `frontend/src/screener/ResultTable.tsx`
  - Added an embedded mode so the results table can live inside the right pane without introducing another visible card.
- `frontend/src/heatmap/HeatmapBoard.tsx`
  - Added a route-level QA/test hook (`data-testid="heatmap-board"`).
- `frontend/src/ui/PageShell.tsx`
  - Widened `PanelCard` props to forward DOM attributes required for route test hooks.

## Verification

- Route tests:
  - `cd frontend && npm test -- Capture.test.tsx Inventory.test.tsx Settings.test.tsx Screener.test.tsx Heatmap.test.tsx StudyPage.test.tsx --run`
  - Result: `7 passed, 64 passed`

- Build:
  - `cd frontend && npm run build`
  - Result: success

## Browser QA

- Dev server ports `5174` and `5175` were already occupied, so QA ran against `http://127.0.0.1:5176/`.
- Inspected `/live`, `/capture`, `/screener`, and `/settings` visually.
- Confirmed no button text overflow at the current desktop width in the inspected routes.
- `/inventory`, `/study`, and `/heatmap` were backend-limited in this environment and stayed on loading states, but those loading shells were updated to use the same route-level surfaces.

## Review findings fixup

- Strengthened `frontend/src/pages/Heatmap.test.tsx` so it now asserts the real route shell (`heatmap-page-primary`) carries the surfaced `bg-bg-card` + `border` classes and still renders `heatmap-board`.
- Added stable child-root hooks to `frontend/src/inventory/StockDateGroupList.tsx` and `frontend/src/inventory/StockDateGroupDetail.tsx`, then extended their focused tests to assert those flattened roots do not regain `bg-bg-card`, `border`, or `rounded-lg`.
- Kept the Inventory route test lightweight; the new child-root assertions are what now catch a future card-in-card regression in the actual list/detail implementations.

## Fix verification

- Requested test slice rerun:
  - `cd frontend && npm test -- Capture.test.tsx Inventory.test.tsx StockDateGroupList.test.tsx StockDateGroupDetail.test.tsx Settings.test.tsx Screener.test.tsx Heatmap.test.tsx StudyPage.test.tsx --run`
  - Result: `9 passed, 86 passed`
- Requested build rerun:
  - `cd frontend && npm run build`
  - Result: success

## Browser / DOM evidence (follow-up)

- Re-ran route QA locally via Vite dev server at `http://127.0.0.1:4173/`.
- `/heatmap`
  - Browser snapshot reached the route and rendered the surfaced main-state message `히트맵을 불러오지 못했습니다.` inside `main`.
  - Test DOM evidence now asserts `heatmap-page-primary` has `bg-bg-card` + `border`, and `heatmap-board` remains present when data loads.
- `/inventory`
  - Browser snapshot reached the route and rendered the surfaced main-state message `캡처된 데이터가 없습니다.` inside `main`.
  - Focused child tests now assert `stock-date-group-list-root` and `stock-date-group-detail-root` stay flattened with no `bg-bg-card`, `border`, or `rounded-lg`.
- `/settings`
  - Browser snapshot confirmed the surfaced primary pane and its `앱 정보`, `Symbol Master`, and `로드맵` regions render together in `main`, with no obvious nested-card structure at the route level.
- Backend/API errors were still present in this environment during browser QA, so route-state DOM evidence was captured from the surfaced error/empty shells plus the strengthened test assertions above.
