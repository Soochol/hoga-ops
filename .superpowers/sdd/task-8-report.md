Status: DONE

Summary:
- Added display priority policies `hogaplay_first`, `kis_ws_first`, and `kis_api_first` with localStorage migration from legacy `hogaplay` and `kis_live`.
- Kept `source_pref` as the outbound request parameter while sending display-priority policy values.
- Added `kis_api` as a frontend source name and updated source chips to label `hogaplay · tick`, `KIS WS · 10s`, and `KIS API · 30s`.
- Added watchlist drawer storage labels for WS, API, excluded, and waiting states without replacing the existing collection status dot.

Verification:
- `npm --prefix frontend test -- sourcePreference.test.ts SourceChip.test.tsx range.test.tsx LiveSettingsSections.test.tsx WatchlistDrawer.test.tsx --run` passed: 5 files, 61 tests.
- `npm --prefix frontend run build` passed.

Concerns:
- None.
