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
