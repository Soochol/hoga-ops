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
