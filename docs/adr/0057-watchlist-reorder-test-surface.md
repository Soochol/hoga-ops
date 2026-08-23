# Watchlist drag-reorder: jsdom tests the wiring, e2e tests the pointer drag

> ⚠ **번호 충돌: `ADR-0057` 은 두 문서를 가리킨다** — 이것과
> `0057-screener-kis-authoritative-factor-store.md`. 병행 세션이 같은 번호를 동시에 붙인 결과이고,
> **둘 다 인용돼 있어 옮기지 않는다**(번호를 바꾸면 리포 전역의 인용마다
> 「둘 중 어느 쪽이었나」를 판정해야 하고, 커밋 메시지·이슈의 인용은 아예
> 고칠 수 없다). 「ADR-0057」 을 만나면 **문맥으로** 가른다.
>
> 새 ADR 은 이 상황을 만들지 말 것 — `tests/unit/test_adr_numbering.py` 가
> 새 충돌을 막고, 위 다섯 쌍만 역사로 동결돼 있다.

> **갱신 노트 (2026-06-08, ADR-0066):** 아래 본문은 v0.5.5.0에서 *제거된* 평면 패널
> 드래그(`PUT /api/watchlist/order`, `reorderCodes`/`reorderWatchlist`,
> `watchlist-reorder.spec.ts`)를 서술한 역사적 기록이다. 현재 패널 드래그는 폴더 인지
> 형태로 복귀했다(ADR-0066): 엔트리 재정렬은 `PUT /api/watchlist/reorder`, 폴더
> 재정렬은 `PUT /api/watchlist/folders/order`이며, wiring 테스트는
> `WatchlistDrawer.drag.test.tsx`(dnd-kit passthrough 모킹), 실 포인터 e2e는
> `watchlist-panel-drag.spec.ts`다. 테스트를 *층으로 분리*한다는 이 ADR의 핵심 결정은
> 그대로 유효하다.

The **Watchlist Panel**'s drag-reorder spans real dnd-kit providers (`DndContext` / `SortableContext` / `PointerSensor` collision detection) whose pointer-event behavior is fragile to simulate in jsdom. We therefore split the test surface by layer rather than forcing one test to cover all of it: `reorderCodes` is a pure unit test (algorithm + null guards); `useReorderWatchlist` is a hook unit test (optimistic cache reshape + rollback); and `WatchlistDrawer.test.tsx` **deliberately mocks** `DndContext`/`SortableContext` to pass-through and capture the injected `onDragEnd`, verifying only the wiring contract (`onDragEnd` → `reorderCodes` → `reorderWatchlist` mutate). The real pointer-drag → `closestCenter` collision → reorder → `PUT /api/watchlist/order` persistence chain is an end-to-end concern, verified in Playwright (`frontend/tests/e2e/`), not jsdom.

## Consequences

- A reviewer who sees the mocked `DndContext` in `WatchlistDrawer.test.tsx` should **not** treat it as a coverage gap — exercising real dnd-kit collision detection in jsdom is what this decision rejects. The wiring contract is unit-tested; the observable pointer behavior is the e2e's job.
- **Real-pointer e2e (landed):** `frontend/tests/e2e/watchlist-reorder.spec.ts` drives a real dnd-kit drag in system Chrome — `mouse.down` → step past the 8px activation → travel onto the target → `mouse.up` — and asserts the `PUT /api/watchlist/order` body, the optimistic DOM reshuffle, and persistence across reload. Backend-independent via `page.route` mocks where the GET `/api/watchlist` mock is **stateful** (the PUT mock mutates the order it returns), so the invalidate-refetch and the reload observe the persisted order rather than snapping back. This is the canonical coverage for the real dnd-kit chain; the jsdom `WatchlistDrawer` test covers only the wiring contract.
