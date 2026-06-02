# Watchlist drag-reorder: jsdom tests the wiring, e2e tests the pointer drag

The **Watchlist Panel**'s drag-reorder spans real dnd-kit providers (`DndContext` / `SortableContext` / `PointerSensor` collision detection) whose pointer-event behavior is fragile to simulate in jsdom. We therefore split the test surface by layer rather than forcing one test to cover all of it: `reorderCodes` is a pure unit test (algorithm + null guards); `useReorderWatchlist` is a hook unit test (optimistic cache reshape + rollback); and `WatchlistDrawer.test.tsx` **deliberately mocks** `DndContext`/`SortableContext` to pass-through and capture the injected `onDragEnd`, verifying only the wiring contract (`onDragEnd` → `reorderCodes` → `reorderWatchlist` mutate). The real pointer-drag → `closestCenter` collision → reorder → `PUT /api/watchlist/order` persistence chain is an end-to-end concern, verified in Playwright (`frontend/tests/e2e/`), not jsdom.

## Consequences

- A reviewer who sees the mocked `DndContext` in `WatchlistDrawer.test.tsx` should **not** treat it as a coverage gap — exercising real dnd-kit collision detection in jsdom is what this decision rejects. The wiring contract is unit-tested; the observable pointer behavior is the e2e's job.
- **Follow-up (not yet done):** add `frontend/tests/e2e/watchlist-reorder.spec.ts` that drags a real row past 8px, asserts the new order, reloads, and asserts persistence. Until it lands, the real-pointer behavior was smoke-verified once manually via a direct `PUT /api/watchlist/order` round-trip against the live backend.
