Status: verified, ready to land
Timestamp: 2026-07-05 21:00:42 KST

Fixes:
- `frontend/src/live/LivePage.tsx`: derive the active pane profile with `panePrefsForTimeframe(...)` and gate both stock `useLiveBundle(..., { investorNetEnabled })` and index `useLiveIndexInvestorNet(...)` from the active timeframe profile instead of the legacy flat investor flags.
- `frontend/src/live/indicators/IndicatorPanel.tsx`: sync `selectedProfile` from the live chart `timeframe` prop so an already-open modal edits the current timeframe profile after chart timeframe changes.
- Regression coverage: added `LivePage` tests for D-profile investor-net enablement with legacy flat flags left false, and an `IndicatorPanel` rerender test proving profile selection follows timeframe changes.

Verification:
- `cd frontend && npm test -- --run src/live/LivePage.test.tsx src/live/indicators/IndicatorPanel.test.tsx src/live/LiveChartRoot.paneToggles.test.tsx`
  - PASS (`3` files, `98` tests)
- `cd frontend && npm run build`
  - PASS

Concerns:
- None in the requested scope.
