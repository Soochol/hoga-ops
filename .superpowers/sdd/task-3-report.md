Status: done

Summary:
- Replaced the `/live` detail-card section markup with `DataSection` while preserving the existing `data-testid`, `data-card`, and min-height behavior through a thin wrapper because `DataSection` does not currently accept arbitrary section props.
- Added the flat-section regression test requested in the brief.
- Moved the quiet-terminal surface styling out of `global.css` into `LivePage`, `LiveWorkarea`, `WorkspaceShell`, `ChartTabBar`, `TimeframeControl`, and `LiveStatusBar`, then removed the one-off live theme selectors.

Verification:
- `cd frontend && npm test -- LiveDetailPanel.test.tsx --run`
- `cd frontend && npm test -- LiveDetailPanel.test.tsx LiveToolbar.test.tsx LiveStatusBar.test.tsx LivePage.test.tsx --run`
- `cd frontend && npm run build`
- Browser QA on `http://127.0.0.1:5176/live?code=005930` (5174/5175 were already occupied): verified one outer detail surface, flat inner sections, matching surface family across header/tab/status/toolbar/chart/detail, and no toolbar text overlap at the checked viewport.

Concerns:
- Dev browser QA was limited by existing localhost API CORS failures in this environment, so the visual pass used the shell with `?code=005930` and empty-data states rather than live backend data.

---

Fix follow-up (review findings only):

Summary:
- Removed the decorative gradient background from `frontend/src/live/LivePage.tsx` so the live root no longer paints a visual gradient.
- Updated `frontend/src/live/LiveWorkarea.tsx` to render the splitter with `LIVE_WORKAREA_SPLITTER_WIDTH_PX`, aligning the DOM width with the clamp and resize math.
- Restored `frontend/src/ui/WorkspaceShell.tsx` to the Task 2 primitive contract: `WorkspaceHeader` uses `bg-bg-subtle/80 px-3`, and `WorkspaceToolbar` height is `var(--h-toolbar)`.
- No additional test expectation changes were needed; the existing primitive test already encoded the Task 2 toolbar height.

Verification:
- `cd frontend && npm test -- WorkspaceShell.test.tsx --run` -> PASS (1 file, 5 tests)
- `cd frontend && npm test -- LiveDetailPanel.test.tsx LiveToolbar.test.tsx LiveStatusBar.test.tsx LivePage.test.tsx WorkspaceShell.test.tsx --run` -> PASS (5 files, 69 tests)
- `cd frontend && npm run build` -> PASS

Concerns:
- None beyond the previously noted browser-QA/API limitations; these review-only fixes were covered by the required test/build verification.
