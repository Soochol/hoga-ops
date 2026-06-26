Task 6 Report: Labelled Marker Primitive And Ratio Integration

Summary
- Added a dedicated `BrokerLateEntryMarkersPrimitive` for ratio-pane broker late-entry dots + grouped labels.
- Extended `RangeSeriesPane` with a narrow `labelMarkers` path that lives alongside existing `markers` without changing `SurgeMarkersPrimitive`.
- Wired ratio context/spec so broker late-entry labels are produced only when `brokerLateEntryEnabled` is true, while keeping the returned context stable across renders.

TDD Log
1. Red
   - Added a failing ratio-spec test in `frontend/src/chart/projectors/ratio.test.ts` for `RATIO_SPEC.series[0].labelMarkers`.
   - Added a failing lifecycle test in `frontend/src/chart/RangeSeriesPane.test.tsx` asserting attach/detach for a `labelMarkers` series.
   - Ran:
     - `cd frontend && npm test -- --run src/chart/projectors/ratio.test.ts src/chart/RangeSeriesPane.test.tsx`
   - Observed the expected failures:
     - `labelMarkers` missing from the ratio spec.
     - label primitive not attached/detached by `RangeSeriesPane`.

2. Green
   - Implemented `frontend/src/chart/BrokerLateEntryMarkersPrimitive.ts` with:
     - per-marker chart/series coordinate lookup on each draw,
     - dot rendering,
     - adaptive regrouping via `layoutBrokerLateEntryLabels(...)`,
     - stacked full labels for shared x positions,
     - mixed-side grouped chips with buy/sell accent dots.
   - Extended `RangeSeriesPane` with:
     - `SeriesSpec.labelMarkers`,
     - `labelMarkersRef`,
     - attach/detach/update lifecycle mirroring the existing marker primitive,
     - independent cleanup so label primitives detach even when surge markers are absent.
   - Extended `ratio.ts` with:
     - broker late-entry fields on `RatioPaneContext`,
     - stable combined context from `useActivePrefs` + `useLivePageStore`,
     - ratio-spec `labelMarkers` gated by `brokerLateEntryEnabled`.

3. Build fixes required by the task changes
   - Narrowed `projectBrokerLateEntryMarkers(...)` context typing so it only requires the ratio fields it actually consumes.
   - Made `RangeBundle.broker_late_entries` optional and defaulted to `[]` in the projector so older fixtures/tests still compile cleanly.
   - Updated ratio-context test fixtures to satisfy the expanded `RatioPaneContext`.

Files Changed
- Added: `frontend/src/chart/BrokerLateEntryMarkersPrimitive.ts`
- Modified:
  - `frontend/src/chart/RangeSeriesPane.tsx`
  - `frontend/src/chart/projectors/ratio.ts`
  - `frontend/src/chart/RangeSeriesPane.test.tsx`
  - `frontend/src/chart/projectors/ratio.test.ts`
  - `frontend/src/chart/projectors/brokerLateEntryMarkers.ts`
  - `frontend/src/chart/projectors/brokerLateEntryMarkers.test.ts`
  - `frontend/src/chart/projectors/pastCachedProjector.test.ts`
  - `frontend/src/chart/projectors/ratio.intramax.test.ts`
  - `frontend/src/api/types.ts`

Verification
- Targeted red/green test:
  - `cd frontend && npm test -- --run src/chart/projectors/ratio.test.ts src/chart/RangeSeriesPane.test.tsx`
- Required task test suite:
  - `cd frontend && npm test -- --run src/chart/projectors/brokerLateEntryMarkers.test.ts src/chart/projectors/ratio.test.ts src/chart/RangeSeriesPane.test.tsx`
  - Result: 3 files passed, 30 tests passed.
- Build:
  - `cd frontend && npm run build`
  - Result: success (`tsc -b && vite build`)

Notes / Concerns
- I kept the existing surge-marker path untouched and parallelized the new label path exactly as requested.
- The new label primitive recomputes grouping from live chart coordinates on every draw, so grouping responds to zoom/pan without caching stale time-only clusters.
- The only type-level compatibility change outside the task-owned chart files was making `RangeBundle.broker_late_entries` optional so pre-existing fixtures that omit the field continue to build.

## Task 6 Fix Report

Summary
- Restored `RangeBundle.broker_late_entries` to a required field in `frontend/src/api/types.ts`.
- Removed the fallback masking from `projectBrokerLateEntryMarkers(...)` so the projector reads `bundle.broker_late_entries` directly.
- Added `broker_late_entries: []` to synthetic/test `RangeBundle` fixtures that were missing the field.

Verification
- `cd frontend && npm test -- --run src/chart/projectors/brokerLateEntryMarkers.test.ts src/chart/projectors/ratio.test.ts src/chart/RangeSeriesPane.test.tsx`
  - Result: pass (`3` files, `30` tests).
- `cd frontend && npm run build`
  - Result: success (`tsc -b && vite build`).

Notes / Concerns
- This supersedes the earlier Task 6 note that made `broker_late_entries` optional for fixture compatibility.
- `vite build` still emits the pre-existing large-chunk warning for the main bundle, but the build completes successfully.
