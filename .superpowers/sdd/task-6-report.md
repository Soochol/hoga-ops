# Task 6 Report: Indicator Panel Profile Selector

## Status

Completed.

## Scope completed

- Wired `IndicatorPanel` to accept the active `timeframe`.
- Added the pane-profile selector UI for `minute`, `D`, `W`, and `M`.
- Routed pane-profile categories through `panePrefsForTimeframe` for reads and `setPanePrefForTimeframe` for writes.
- Kept non-profile categories global:
  - MA
  - Daily MA
  - ask/bid peak
  - POC
  - volume distribution
  - broker late entry
- Passed `timeframe` from both `/live` and `/study`.
- Added focused tests for:
  - defaulting the selector to the active timeframe
  - writing pane-category changes only to the selected profile
  - `/live` passing its active timeframe to the panel
  - `/study` passing its active timeframe to the panel

## Notes on implementation

- I avoided the brief’s cast-heavy synthetic persisted object path.
- Instead, I narrowed `indicatorPaneProfiles.ts` to accept a type-safe pane-profile indicator snapshot containing only the fields that profile resolution actually needs.
- `IndicatorPanel` now reads that real snapshot from `useLivePageStore`, so selector behavior stays aligned with the same profile resolution logic already used elsewhere.

## Files changed

- `frontend/src/live/indicators/IndicatorPanel.tsx`
- `frontend/src/live/indicators/IndicatorPanel.test.tsx`
- `frontend/src/live/indicators/indicatorPaneProfiles.ts`
- `frontend/src/live/LivePage.tsx`
- `frontend/src/live/LivePage.test.tsx`
- `frontend/src/studyViews/StudyPage.tsx`
- `frontend/src/studyViews/StudyPage.test.tsx`

## Verification

Ran:

```bash
cd frontend && npm test -- --run src/live/indicators/IndicatorPanel.test.tsx src/live/LivePage.test.tsx src/studyViews/StudyPage.test.tsx
cd frontend && npm run build
```

Results:

- Focused tests passed: `3` files, `101` tests.
- Frontend build passed with `tsc -b && vite build`.

## Constraints respected

- Did not edit persistence behavior or store actions.
- Did not edit `PaneLegendOverlay`.
- Did not edit chart pane resolution behavior.
- Did not edit backend files or study save payload/API tests.

## Concerns

- None from this task’s scope after verification.

---

## Review Fix: Active Study Timeframe for Indicator Panel

### Status

Completed.

### Fix applied

- Added a single `indicatorPanelTimeframe` source in `StudyPage.tsx`.
- Reused that value across every `IndicatorPanel` render path, including empty, loading, error, and ready states.
- Stopped falling back to `selectedSave?.timeframe` for the panel profile selector.

### Regression test

- Added a loading-path test in `StudyPage.test.tsx` that opens `IndicatorPanel` while the reference bundle is still loading and verifies the panel receives the active study tab timeframe.

### Verification

- `cd frontend && npm test -- --run src/studyViews/StudyPage.test.tsx src/live/indicators/IndicatorPanel.test.tsx src/live/LivePage.test.tsx`
- `cd frontend && npm run build`

### Results

- Focused tests passed: `3` files, `102` tests.
- Frontend build passed with `tsc -b && vite build`.
