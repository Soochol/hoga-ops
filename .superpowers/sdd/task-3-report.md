Status: DONE
Commit: none

Files changed
- frontend/src/api/rangeRequest.ts
- frontend/src/api/range.test.tsx
- .superpowers/sdd/task-3-report.md

Tests run with pass/fail
- FAIL: `cd frontend && npx vitest run src/api/range.test.tsx` initially failed before tests loaded because `frontend/node_modules` was absent (`vitest/config` and `@vitejs/plugin-react` unresolved).
- FAIL: after `npm ci`, `cd frontend && npx vitest run src/api/range.test.tsx` failed as expected: `volumeDistributionCutoffMs` was missing from the range query key and `volume_distribution_cutoff_ms` was missing from the URL.
- PASS: `cd frontend && npx vitest run src/api/range.test.tsx` passed with 28 tests.
- PASS: `cd frontend && npm run build` passed.

Notes/risks
- Added `volumeDistributionCutoffMs?: number | null` to range request options and threaded it into `RangeQueryKey` and `/api/range?mode=sidecar` query params as `volume_distribution_cutoff_ms`.
- Kept default behavior as no cutoff (`null`), preserving final full Stock-Date distribution requests unless callers opt in.
- Included cutoff in placeholder compatibility checks so cutoff-specific sidecar responses are not reused for different cutoff values or no cutoff.
- `npm run build` emitted the existing Vite large chunk warning.
- Pre-existing unrelated dirty file left untouched: `.superpowers/sdd/task-2-report.md`.
