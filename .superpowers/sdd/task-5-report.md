Status: DONE

Commit: recorded in the task response

What changed:
- Added `frontend/src/chart/projectors/brokerLateEntryMarkers.ts` with a pure broker late-entry marker projector for the ratio pane.
- Matched ratio-pane y-value rules by reusing quote-ratio point preparation, skipping synthetic gap / auction-hidden buckets, and applying the same outlier clamp logic as `projectRatio`.
- Implemented fallback-to-earlier-anchor only when the exact ratio bucket is absent, and kept that fallback constrained to the same axis session.
- Added `layoutBrokerLateEntryLabels(...)` as a pure grouping helper with deterministic ordering, compact mixed-side grouping, and optional coordinate accessors for Task 6 integration.
- Added `frontend/src/chart/projectors/brokerLateEntryMarkers.test.ts` covering side filtering, color selection, missing-bucket fallback, hidden-bucket skips, outlier clamping, session-boundary behavior, and compact/full label grouping.

TDD record:
- RED: `cd frontend && npm test -- --run src/chart/projectors/brokerLateEntryMarkers.test.ts` failed because `./brokerLateEntryMarkers` did not exist.
- GREEN: the same command passed after implementing the projector/helper.

Verification:
- `cd frontend && npm test -- --run src/chart/projectors/brokerLateEntryMarkers.test.ts`
- Result: 1 file passed, 8 tests passed, 0 failures.

Concerns:
- None for Task 5. The helper exposes optional `getX` / `getY` hooks so Task 6 can feed real chart pixel coordinates without changing the event model.
