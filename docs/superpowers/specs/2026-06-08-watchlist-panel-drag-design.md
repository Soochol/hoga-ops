# 관심종목 패널 — 드래그 재정렬 복귀 (폴더 인지)

**날짜:** 2026-06-08
**상태:** 디자인 승인 완료 (접근안 A + "그룹 내 한정" 스코프 확정)
**대상:** `frontend/src/watchlist/WatchlistDrawer.tsx`, `frontend/src/watchlist/dragHandlers.ts`, `frontend/src/watchlist/useWatchlist.ts`, `frontend/src/watchlist/grouping.ts`(읽기), `frontend/src/rightrail/QuoteRow.tsx`(무변경 재사용), `docs/adr/0057-*`(갱신) + 신규 ADR

## 문제

> 사용자: "관심종목 우측 사이드패널에서 그룹내 종목을 마우스 드래그로 이동할 수 있도록 해줘, 그룹도 마우스 드래그 이동하도록 해줘."

현재 사이드패널(`WatchlistDrawer`)에서는 종목·그룹의 순서를 바꾸려면 ⋯ 메뉴의 "위로/아래로 이동" 버튼을 한 칸씩 누르거나 편집 모달을 열어야 한다. 직접 조작(direct manipulation)인 마우스 드래그가 없다.

역사적 배경: 패널은 v0.5.5.0에서 폴더 그룹 구조로 바뀌며 **평면 드래그 재정렬**(`PUT /api/watchlist/order`)이 제거되고 모든 구조 편집이 편집 모달로 일원화됐다. 드래그가 나빠서가 아니라 평면 목록이 그룹 목록으로 바뀌며 평면 드래그가 의미를 잃었기 때문이다. 이 spec은 드래그를 **폴더를 인지하는 형태**로 패널에 되돌린다.

코드베이스는 이 복귀를 이미 예비해 두었다: `QuoteRow`는 미사용 드래그 props(`sortableRef`/`sortableStyle`/`dragListeners`/`dragAttributes`/`dragging`)를 보유하고, `useWatchlist.ts`의 폴더 재정렬 주석은 "folder-DnD 도입 시 낙관적 경로 필요"라고 명시적으로 후속을 연기해 두었으며, `resolveDrag`·`reorderEntries`(낙관적)·`reorderFolders` 백엔드 경로도 이미 존재한다.

## Invariants

이 spec이 건드리는 시스템이 현재 보존하는 속성들:

- **그룹 내 `.order` 정렬 렌더**: 패널·편집 모달·entry pane 모두 종목을 그룹 내 `.order` 오름차순으로 그린다. 근거: [grouping.ts](../../../frontend/src/watchlist/grouping.ts) `groupByFolder`/`selectVisibleEntries`.
- **폴더 `.order` 정렬 + 미분류 항상 맨 끝**: 실폴더는 `.order` 순, `folder_id===null`(미분류)는 렌더 전용 그룹으로 항상 마지막. 근거: `groupByFolder`(grouping.ts:38–41), ADR-0004.
- **미분류는 합성 폴더 객체가 아님**: 미분류는 폴더 id가 없는 렌더 전용 그룹이라 폴더 CRUD/순서 대상이 아니다. 근거: ADR-0004, grouping.ts 주석.
- **행 클릭 = 차트 이동(`onPick`)**: 패널 종목 행 클릭은 `activeCode` 설정 + `/live` 점프. 근거: WatchlistDrawer.tsx `onClick={() => onPick(entry.code)}`.
- **행 우클릭 = 컨텍스트 메뉴, Delete = 삭제**: `QuoteRow`의 `onContextMenu`/Delete 키 계약. 근거: QuoteRow.tsx onKeyDown.
- **재정렬 no-jump 불변식**: 서버가 target 그룹을 0..N-1로 compact 유지(`_reindex`)하므로 낙관적 `.order`가 invalidate 후 같은 *상대순서*에 안착해 화면이 튀지 않는다. 근거: useWatchlist.ts:92–94 주석.
- **접기 상태 localStorage 영속 + 실존 키만 기록**: `watchlist.collapsed`는 실존 그룹 키(+`__uncat__`)만 남긴다. 근거: WatchlistDrawer.tsx useEffect.
- **그룹 헤더 클릭 = 접기 토글, ⋯ 메뉴 = 이름변경/순서/삭제**: 헤더 전체가 토글·메뉴 버튼으로 구성. 근거: GroupHeader.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 그룹 내 `.order` 정렬 렌더 | preserves | 드래그는 `reorderEntries`를 거쳐 `.order`를 갱신, 렌더 경로 불변 |
| 폴더 `.order` 정렬 + 미분류 맨 끝 | preserves | 폴더 드래그는 실폴더 id 목록만 재정렬, 미분류는 SortableContext 밖에 렌더 |
| 미분류는 합성 폴더 아님 | preserves | 미분류 그룹에 드래그 핸들 미부여 → 폴더 순서 대상 제외 |
| 행 클릭 = 차트 이동 | preserves | PointerSensor `distance:5` 임계 — 5px 미만 이동은 클릭, 그 이상만 드래그 |
| 행 우클릭/Delete | preserves | QuoteRow 핸들러 우선 스프레드 계약(QuoteRow.tsx 57–61행 주석) 그대로 |
| 재정렬 no-jump | preserves | 기존 낙관적 `reorderEntries` 재사용; 폴더는 동형의 `applyFolderReorder` 신설로 동일 보장 |
| 접기 상태 영속 | preserves | 폴더 순서가 바뀌어도 키(폴더 id)는 불변 |
| 헤더 클릭 = 토글 | preserves | 드래그는 헤더 안 **별도 ⠿ 핸들**에만 listeners — 토글/메뉴와 충돌 없음 |

*의도적으로 깨는 invariant 없음.*

## Goals

- 패널에서 같은 그룹 내 종목을 마우스로 끌어 순서를 바꿀 수 있다(드롭 시 `PUT /api/watchlist/reorder`).
- 패널에서 그룹(폴더)을 마우스로 끌어 순서를 바꿀 수 있다(드롭 시 `PUT /api/watchlist/folders/order`).
- 두 동작 모두 낙관적 업데이트로 드롭 즉시 반영되고 화면이 튀지 않는다.
- 기존 행 클릭(차트 이동)·우클릭 메뉴·Delete·접기 토글·⋯ 메뉴가 모두 그대로 동작한다.
- 편집 모달의 드래그/구조 편집은 그대로 공존한다(패널 드래그는 빠른 재정렬용 *추가*).

## Non-Goals

- **그룹 간 드래그 이동**(A그룹 종목을 B그룹으로 끌어다 놓기) — 우클릭 "그룹으로 이동" + 편집 모달이 담당. 사용자가 "그룹 내 재정렬만"을 선택.
- **키보드 드래그**(`KeyboardSensor`) — ⋯ 메뉴의 위로/아래로가 키보드 경로.
- **멀티선택 드래그** — 편집 모달의 체크박스 다중선택이 담당.
- 편집 모달·entry pane 변경.

## Design

### 접근안 A — 단일 DndContext + 타입 태깅 중첩 sortable

`WatchlistDrawer`의 스크롤 영역(`[data-testid="watchlist-scroll"]`)을 `<DndContext>` 하나로 감싼다. 편집 모달과 같은 단일 컨텍스트 패턴(dnd-kit 권장 — 컨텍스트 중첩 회피).

```
<DndContext sensors={[PointerSensor distance:5]} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
  <SortableContext items={realFolderIds} strategy={verticalListSortingStrategy}>   ← 폴더 순서
    {realFolderGroups.map(g => (
      <SortableGroup folderId={g.folder.id} ...>                                    ← 그룹 컨테이너 = 폴더 sortable 노드
        <GroupHeader dragHandle={...} .../>                                         ← 헤더 내 ⠿ 핸들에만 listeners
        <SortableContext items={groupCodes} strategy={verticalListSortingStrategy}> ← 이 그룹 종목 순서
          {g.entries.map(e => <SortableQuoteRow entry={e} folderId={g.folder.id} .../>)}
        </SortableContext>
      </SortableGroup>
    ))}
  </SortableContext>
  {/* 미분류는 SortableContext 밖 — 폴더 순서 대상 아님(항상 맨 끝). 단 안의 종목은 자체 SortableContext로 재정렬 가능 */}
  <div>
    <GroupHeader /* 핸들 없음 */ .../>
    <SortableContext items={uncatCodes}>{...<SortableQuoteRow folderId={null} .../>}</SortableContext>
  </div>
</DndContext>
```

각 sortable은 `useSortable({ id, data: { type, folderId } })`로 종류를 태깅한다:
- 폴더: `useSortable({ id: folderId, data: { type: 'folder' } })` — `setNodeRef`는 그룹 컨테이너 `<div>`, listeners는 헤더 ⠿ 핸들로 전달.
- 종목: `useSortable({ id: code, data: { type: 'entry', folderId } })` — `setNodeRef`/listeners/attributes를 `QuoteRow`의 props로 주입(행 전체 드래그).

### 드래그 affordance

- **종목 행 — 행 전체 드래그.** `QuoteRow`가 이미 드래그 props를 받으므로 그대로 배선. `distance:5` 임계가 클릭(차트 이동)과 드래그를 구분한다. 드래그 중 `dragging` prop으로 `opacity:0.6`(QuoteRow 기존 처리). 신규 시각 요소 없음 → 좁은 패널의 밀도 보존.
  - *대안(채택 안 함)*: ⠿ 핸들. 패널 폭이 좁아 영구 컬럼은 밀도 비용. 사용자 요청 시 hover-노출 핸들로 전환 가능.
- **그룹 헤더 — 전용 ⠿ 드래그 핸들.** 헤더는 chevron·라벨·⋯ 가 모두 버튼이라 전체 드래그가 토글과 충돌. 헤더 좌측에 `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`(기존 ⋯ 관용구)로 ⠿ 핸들을 노출하고 폴더 listeners를 핸들에만 건다. `cursor-grab select-none touch-none`. 미분류 헤더에는 핸들 미부여.
- **⋯ 메뉴 "위로/아래로 이동" 유지** — 마우스 없는 키보드 경로.

### onDragEnd 분기

```ts
const onDragEnd = (ev: DragEndEvent) => {
  if (!ev.over) return;
  const type = ev.active.data.current?.type;
  if (type === 'folder') {
    // over가 폴더 노드면 그 id, 대상 그룹의 *행*이면 행의 folderId로 정규화한다 —
    // closestCenter가 폴더 드래그 중 행을 최근접으로 고를 수 있어 over.id가 code일 수
    // 있다(그대로 두면 indexOf=-1 → no-op으로 드롭이 불안정). 미분류(folderId=null)
    // 위로 떨어지면 폴더 순서 변경 없음(미분류는 항상 끝).
    const over = ev.over.data.current;
    const overFolderId = over?.type === 'folder' ? String(ev.over.id) : (over?.folderId ?? null);
    if (overFolderId == null) return;
    const r = resolveFolderDrag(realFolderIds, String(ev.active.id), overFolderId);
    if (r.kind === 'reorder') reorderFoldersM.mutate(r.orderedIds);
    return;
  }
  // type === 'entry'
  const folderId = ev.active.data.current?.folderId ?? null;
  const group = (data?.entries ?? [])
    .filter((e) => e.folder_id === folderId)
    .sort((a, b) => a.order - b.order);
  const r = resolveDrag(group, folderId, String(ev.active.id), String(ev.over.id));
  if (r.kind === 'reorder') reorderEntriesM.mutate({ folderId: r.folderId, orderedCodes: r.orderedCodes });
  // r.kind === 'move'는 패널에서 무시(그룹 간 이동 Non-Goal) — 사실상 over가 다른 그룹이면 resolveDrag가 'none' 반환
};
```

**그룹 내 한정의 구조적 보장**: `resolveDrag`에 *액티브 행이 속한 그룹의 종목만* 넘기므로, 다른 그룹의 행 위에 드롭하면 `to = findIndex(...) = -1` → `kind:'none'`. 별도 cross-group 가드 코드 불필요(이미 [dragHandlers.ts](../../../frontend/src/watchlist/dragHandlers.ts) `resolveDrag`가 그렇게 동작, dragHandlers.test.ts가 검증). 패널은 folder-droppable(`folder:` prefix)을 등록하지 않으므로 `resolveDrag`의 'move' 분기는 트리거되지 않는다.

### 신규/변경 부품

**1. `dragHandlers.ts` — `resolveFolderDrag` 추가**
```ts
export type FolderDragResult = { kind: 'reorder'; orderedIds: string[] } | { kind: 'none' };
/** activeId 폴더를 overId 폴더 위치로 옮긴 전체 id 순서. arrayMove 기반(임의 위치).
 *  기존 swapFolderOrder(한 칸 swap, ⋯ 메뉴용)와 달리 드래그의 임의 거리 이동을 지원. */
export function resolveFolderDrag(orderedIds: string[], activeId: string, overId: string): FolderDragResult {
  const from = orderedIds.indexOf(activeId);
  const to = orderedIds.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return { kind: 'none' };
  return { kind: 'reorder', orderedIds: arrayMove(orderedIds, from, to) };
}
```
`resolveDrag`와 같은 파일·같은 codec 철학. `swapFolderOrder`(grouping.ts)는 ⋯ 메뉴 전용으로 존치.

**2. `useWatchlist.ts` — 폴더 재정렬 낙관적 경로 신설**
- `applyFolderReorder(data, orderedIds)`: `orderedIds`의 인덱스를 폴더 `.order`로 재배치(entries의 `applyReorder`와 동형).
```ts
function applyFolderReorder(data: WatchlistResponse, orderedIds: string[]): WatchlistResponse {
  const rank = new Map(orderedIds.map((id, i) => [id, i] as const));
  return { ...data, folders: data.folders.map((f) => rank.has(f.id) ? { ...f, order: rank.get(f.id)! } : f) };
}
```
- 기존 제네릭 훅 `useOptimisticEntryMutation`을 `useOptimisticWatchlistMutation`으로 일반화(이름만; 시그니처 동일). `useReorderFolders`를 invalidate-only에서 낙관적으로 전환:
```ts
export function useReorderFolders() {
  return useOptimisticWatchlistMutation<string[]>((ids) => reorderFolders(ids), applyFolderReorder);
}
```
- useWatchlist.ts:141–143의 "비낙관적 — folder-DnD 도입 시 병렬 path 필요" 연기 주석을 갱신/삭제.

**3. `WatchlistDrawer.tsx` — DnD 배선**
- `DndContext` + 중첩 `SortableContext` 도입(위 구조).
- 모듈 스코프 컴포넌트 신설(react-hooks/static-components 규칙 — 루프 안 훅 금지):
  - `SortableGroup`: 폴더 `useSortable`, `setNodeRef`+`sortableStyle`을 그룹 컨테이너에, listeners를 children(헤더)로 전달.
  - `SortableQuoteRow`: 종목 `useSortable`, props를 `QuoteRow`에 매핑.
- `GroupHeader`에 `dragHandle?: { listeners; attributes }` prop 추가 — 있으면 좌측 ⠿ 핸들 렌더(미분류는 미전달).
- `useReorderEntries`(이미 존재) import + `onDragEnd` 배선. `reorderFoldersM`은 이미 import됨(낙관적으로 바뀜).
- sensors: `useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))`.

**4. `QuoteRow.tsx` — 변경 없음.** 기존 드래그 props 그대로 사용.

### 엣지 케이스

- **접힌 그룹**: 종목 미렌더 → 안쪽 SortableContext items 빈 배열. 그룹 헤더(⠿ 핸들)는 여전히 드래그 가능 → 폴더 순서 변경 가능.
- **미분류**: 그룹 드래그 불가(핸들 없음), 안의 종목 재정렬 가능, 항상 맨 끝.
- **단일 그룹 / 빈 패널 / 그룹 내 1종목**: items 길이 0~1 → 드래그 no-op(자연 처리).
- **sticky 헤더 + 폴더 드래그 transform 상호작용**: 그룹 컨테이너에 transform이 걸릴 때 내부 sticky 헤더 거동은 브라우저 실검증 필요(Risks 참조).

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| `resolveFolderDrag` 재정렬 | `['a','b','c']`, active=`c`, over=`a` | `{kind:'reorder', orderedIds:['c','a','b']}` |
| `resolveFolderDrag` 자기 위/미존재 | active===over / 없는 id | `{kind:'none'}` |
| `applyFolderReorder` reshape | folders order [a:0,b:1,c:2], ids=['c','a','b'] | c.order=0, a.order=1, b.order=2 |
| `useReorderFolders` 낙관적+롤백 | mutate 후 onError | 캐시가 prev로 복원 |

`resolveDrag`(그룹 내 reorder + cross-group no-op)는 dragHandlers.test.ts가 이미 커버 — 회귀만 확인.

**Invariant 회귀 테스트**: "그룹 내 한정"은 `resolveDrag(group, ...)`에 다른 그룹 code를 over로 줘 `{kind:'none'}` 확인(dragHandlers.test.ts 기존 케이스로 충족). "no-jump"는 `applyFolderReorder` 후 폴더가 ids 순서와 일치하는지 검증.

### jsdom 배선 테스트 (`WatchlistDrawer.test.tsx` 확장 — ADR-0057 철학 계승)

`DndContext`/`SortableContext`를 passthrough로 모킹해 주입된 `onDragEnd`를 캡처:
- entry-drag 이벤트(`active.data.type==='entry'`) → `reorderEntries` mock이 올바른 `{folderId, orderedCodes}`로 호출됨.
- folder-drag 이벤트(`active.data.type==='folder'`) → `reorderFolders` mock이 올바른 ids로 호출됨.
- 실제 dnd-kit 충돌 검출은 jsdom에서 검증하지 않음(ADR-0057 결정 유지) → e2e 영역.

### e2e (`frontend/tests/e2e/` — 기존 `watchlist-edit-reorder.spec.ts` 패턴)

stateful `page.route` mock으로:
- **행 재정렬**: 패널에서 한 그룹의 종목을 5px 이상 끌어 다른 행 위로 → `PUT /api/watchlist/reorder` 바디(`folder_id`+`ordered_codes`) 검증 + DOM 재배치 + 새로고침 지속.
- **그룹 재정렬**: 그룹 헤더 ⠿ 핸들을 끌어 다른 그룹 위로 → `PUT /api/watchlist/folders/order` 바디(`ordered_ids`) 검증 + DOM 재배치 + 지속.

### Manual verification

`/live` 우측 관심종목 패널에서: ① 그룹 내 종목 드래그 재정렬, ② 그룹 헤더 ⠿ 드래그로 그룹 재정렬, ③ 행 단순 클릭이 여전히 차트 이동, ④ 우클릭 메뉴·Delete·접기·⋯ 메뉴 정상, ⑤ 드롭 즉시 반영·무튐. (CLAUDE.md의 `/browse` 헤드리스로 확인.)

## Risks / Open questions

- **sticky 헤더 ↔ 폴더 드래그 transform**: 그룹 컨테이너 transform 중 내부 `sticky top-0` 헤더가 어색하게 보일 수 있음. 실검증 후 필요 시 드래그 중 sticky 해제 또는 DragOverlay 도입 검토.
- **중첩 SortableContext 충돌 검출 cross-talk** *(해결: type-aware collision)*: `useSortable`는 그룹 컨테이너를 큰 droppable로 등록하므로, 면적 기반 `closestCenter`가 행 드래그 중 폴더 컨테이너를(또는 그 반대) 최근접으로 골라 재정렬이 조용히 no-op이 될 수 있음(가드로 "흡수"되는 게 아니라 기능 실패). → `DndContext`에 충돌 후보를 액티브와 같은 `data.type`으로 선필터하는 `typeAwareCollision`을 적용해 entry는 entry끼리, folder는 folder 컨테이너끼리만 보게 함(구현 계획 Task 3 Step 4). 폴더 분기의 `over.data.folderId` 정규화는 belt-and-suspenders로 잔존. jsdom wiring 테스트는 이 층을 모킹으로 비껴가므로 **e2e가 유일 실검증**.
- **ADR-0057 stale**: 거기 적힌 `PUT /api/watchlist/order`(현재 `/reorder`)와 "WatchlistDrawer.test.tsx가 DndContext를 모킹한다"(현재는 그룹 렌더 테스트)는 모두 과거 제거된 패널 드래그 서술. 이 spec과 함께 갱신.

## Out of Scope (Backlog)

- 그룹 간 드래그 이동(드롭 타깃: 헤더/접힌 그룹 + 드롭 인디케이터) — `resolveDrag`의 'move' 경로 + folder-droppable 등록이면 가능. 수요 시 후속 spec.
- 키보드 드래그(`KeyboardSensor` + 접근성 안내).
- 멀티선택 드래그.
- DragOverlay 기반 커스텀 드래그 프리뷰.
