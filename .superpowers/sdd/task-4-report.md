# Task 4 Report: Chart Pane Resolution

## Status

DONE

## Files Changed

- `frontend/src/live/LiveChartRoot.tsx`
- `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`

## Changes

1. Added profile-aware pane-resolution coverage in `LiveChartRoot.paneToggles.test.tsx`:
   - seeded `panePrefsByTimeframe` in the shared baseline
   - verified minute profile overrides legacy flat fields
   - verified `/live` D timeframe still suppresses hoga panes
   - verified forced study-style D panes mount when `forceHogaPanes` is enabled
2. Updated `LiveChartRoot.tsx` to resolve pane toggles from the active timeframe profile via `resolvePaneTogglesForTimeframe`.
3. Replaced the local legacy toggle assembly with a single shallow store selector feeding the resolver.
4. Kept `paneTogglesOverride` behavior intact and merged last through the resolver.
5. Switched both the chart-pane mount effect and the render-time pane list to the resolved `activePaneToggles`.

## Validation

- `cd frontend && npm test -- --run src/live/LiveChartRoot.paneToggles.test.tsx` — PASS
- `cd frontend && npm run build` — PASS

## Commit

- `05281853` — `feat: resolve panes from timeframe profiles`

## Concerns

None.

## Task 4 Fix (post-review)

### Change
- In `frontend/src/live/LiveChartRoot.tsx`, narrowed `activePaneToggles` memo dependencies from the whole `paneTogglesOverride` object to individual scalar fields (`hogaPanes`, `volumeEnabled`, `quoteTotalsEnabled`, `ratioEnabled`, `fillStrengthEnabled`, `programTradeEnabled`).
- Constructed the resolver `override` object from scalar values inside the memo to avoid unstable object identity from parent inline overrides while preserving existing precedence and profile-resolution behavior.

### Verification
- `cd frontend && npm test -- --run src/live/LiveChartRoot.paneToggles.test.tsx` — PASS (21 passed, 1 test file)
- `cd frontend && npm run build` — PASS
