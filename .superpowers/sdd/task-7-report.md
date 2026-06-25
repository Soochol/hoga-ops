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

Final verification fix:
- Re-ran `cd frontend && npm run build` and fixed TypeScript failures caused by test fixtures/helpers that had not been updated for required `RangeBundle.volume_distributions` data and required `StudySnapshotDetailInput` volume distribution defaults.
- Kept the runtime contract strict and added fixture-safe defaults in the local test helper builders/literals instead of loosening `RangeBundle`.

Verification:
- PASS: `cd frontend && npm run build`

Concerns:
- Vite still reports the existing large-chunk warning for `dist/assets/index-CZK6amqv.js`; build succeeds and this fix does not change runtime behavior.
