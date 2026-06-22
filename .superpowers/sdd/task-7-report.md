Status: DONE

Summary:
- Added frontend live settings API, storage policy types, and React Query hooks.
- Added watchlist folder capture API and optimistic mutation hook.
- Added folder capture switches in WatchlistEditModal.
- Split live data-source settings into data storage policy and display priority sections.
- Updated Korean labels covered by the Task 7 brief.

Tests:
- PASS: npm --prefix frontend test -- watchlist.test.ts WatchlistEditModal.test.tsx LiveSettingsSections.test.tsx liveSettings.test.ts --run
- PASS: npm --prefix frontend test -- LiveSettingsModal.test.tsx --run

Concerns:
- None.
