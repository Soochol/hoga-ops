Task 3 Report: Suppress Live Inline Labels in Ask/Bid Wall Renderers

Summary
- Added `prepareAskPeakSegmentsForRender` and `prepareBidPeakSegmentsForRender`.
- Routed live ask/bid renderer segment updates through the new render-preparation helpers.
- Kept live geometry intact while blanking inline labels for live segments.
- Added focused render-preparation coverage in `LiveAskPeakSegments.test.tsx`.

TDD Evidence
RED:
- Ran `cd frontend && npm test -- LiveAskPeakSegments.test.tsx`.
- Expected failure appeared first as missing exports:
  - `TypeError: prepareAskPeakSegmentsForRender is not a function`
  - `TypeError: prepareBidPeakSegmentsForRender is not a function`

GREEN:
- Implemented the minimal helpers and wiring in the live ask/bid renderers.
- Re-ran `cd frontend && npm test -- LiveAskPeakSegments.test.tsx`.
- Result: `Test Files 1 passed (1)`, `Tests 29 passed (29)`.

Notes
- The brief’s sample test data used a live-edge fixture that produced a reversed time range in this codebase, so the added test fixture was adjusted to use a valid live-edge span while preserving the same label-suppression assertion.

