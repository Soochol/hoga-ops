# Task 4 Report

## Summary
- Redesigned `IndicatorPanel` and `LiveSettingsModal` with local quiet-terminal modal shells matching the task brief surface language.
- Converted left navigation rows in both dialogs to flat bordered list rows with accent selection treatment.
- Wrapped settings/detail panes in `DataSection` so the modal content reads as flat sections instead of nested cards.
- Updated shared settings rows and numeric inputs to use the quieter row/input treatments required by the brief.
- Added modal/layout regression coverage for the new surface structure.

## Files Changed
- `frontend/src/live/indicators/IndicatorPanel.tsx`
- `frontend/src/live/indicators/IndicatorPanel.test.tsx`
- `frontend/src/live/LiveSettingsModal.tsx`
- `frontend/src/live/LiveSettingsModal.test.tsx`
- `frontend/src/live/LiveSettingsSections.tsx`
- `frontend/src/live/LiveSettingsSections.test.tsx`
- `frontend/src/live/settings/SettingsRow.tsx`
- `frontend/src/live/settings/NumericPrefRow.tsx`
- `frontend/src/live/settings/IndicatorPrefRows.tsx`

## Verification
- `cd frontend && npm test -- IndicatorPanel.test.tsx LiveSettingsModal.test.tsx LiveSettingsSections.test.tsx --run`
- `cd frontend && npm run build`

## Browser QA
- Attempted QA on `http://127.0.0.1:4173/live` and `http://localhost:4173/live`.
- Blocked from opening the in-page `보조지표` and `설정` dialogs because local backend requests to `localhost:8000` were CORS-blocked in this environment, leaving `/live` in the empty/offline shell state without a loaded symbol workspace.

## Notes
- The brief's sample `capabilities` prop was adapted to the real `LiveInstrumentCapabilities` shape by including `studySave: false` in the new indicator layout test.
