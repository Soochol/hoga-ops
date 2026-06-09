# 관심종목 패널 드래그 재정렬 복귀 (폴더 인지)

v0.5.5.0에서 폴더 도입과 함께 제거됐던 패널 드래그(평면 `PUT /api/watchlist/order`)를,
폴더를 인지하는 형태로 사이드패널에 되돌린다. 패널에서 ① 같은 그룹 내 종목 드래그
재정렬(`PUT /api/watchlist/reorder`), ② 그룹(폴더) 드래그 재정렬(`PUT
/api/watchlist/folders/order`)을 지원한다. 그룹 *간* 이동은 의도적으로 범위 밖 —
우클릭 "그룹으로 이동"과 편집 모달이 담당한다.

## 구조

단일 `DndContext`(편집 모달과 동일 패턴, 컨텍스트 중첩 회피) 안에 폴더 순서용 바깥
`SortableContext` 1개 + 그룹별 종목용 안쪽 `SortableContext` N개를 중첩한다. 각
sortable은 `useSortable({ data: { type: 'folder' | 'entry', folderId } })`로 태깅하고
`onDragEnd`가 `active.data.type`으로 분기한다. "그룹 내 한정"은 가드 코드가 아니라
`resolveDrag`에 *액티브 그룹의 종목만* 넘겨 구조적으로 보장한다(다른 그룹 over →
`findIndex=-1` → no-op). 폴더의 sortable 단위는 헤더가 아니라 **그룹 블록 전체**이고,
드래그 핸들(⠿)만 헤더에 둬 헤더 클릭(접기 토글)과 충돌하지 않는다.

## Consequences

- 종목 행은 행 전체가 드래그 표면(PointerSensor `distance:5`로 클릭=차트이동 보존),
  그룹 헤더는 hover-노출 ⠿ 핸들. 비대칭은 헤더가 버튼 클러스터라는 구조적 차이에서 정당.
- `useReorderFolders`는 낙관적+롤백으로 전환(엔트리와 같은 제네릭 경로) — 드롭 즉시 반영.
- 편집 모달의 드래그/구조 편집은 그대로 공존(패널 드래그는 빠른 재정렬용 추가).
- 미분류는 폴더 sortable 대상이 아님(핸들 없음, 항상 맨 끝) — ADR-0004 불변식 유지.
- 테스트 표면은 ADR-0057 계승: 순수 codec(`resolveFolderDrag`)·낙관적 훅은 jsdom 단위,
  onDragEnd wiring은 dnd-kit passthrough 모킹, 실 포인터 드래그는 Playwright e2e.
