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

> ⚠ **⠿ 핸들 조항은 더 이상 사실이 아니다** — 헤더 **전체**가 드래그 활성 영역이고
> 아이콘은 없다(`PointerSensor distance:5` 가 클릭과 드래그를 가른다). 아래
> [Update (2026-08-27)](#update--드래그-피드백-개정-2026-08-27) 참조.

## Consequences

- 종목 행은 행 전체가 드래그 표면(PointerSensor `distance:5`로 클릭=차트이동 보존),
  그룹 헤더는 hover-노출 ⠿ 핸들. 비대칭은 헤더가 버튼 클러스터라는 구조적 차이에서 정당.
  (⚠ 후자는 폐기 — 헤더 전체가 활성 영역이 되어 **비대칭 자체가 사라졌다**. 아래 Update 참조.)
- `useReorderFolders`는 낙관적+롤백으로 전환(엔트리와 같은 제네릭 경로) — 드롭 즉시 반영.
- 편집 모달의 드래그/구조 편집은 그대로 공존(패널 드래그는 빠른 재정렬용 추가).
- 미분류는 폴더 sortable 대상이 아님(핸들 없음, 항상 맨 끝) — ADR-0004 불변식 유지.
- 테스트 표면은 ADR-0057 계승: 순수 codec(`resolveFolderDrag`)·낙관적 훅은 jsdom 단위,
  onDragEnd wiring은 dnd-kit passthrough 모킹, 실 포인터 드래그는 Playwright e2e.

## Update — 드래그 피드백 개정 (2026-08-27)

본 ADR 의 **구조**(sortable 단위 = 그룹 블록, 단일 DndContext, onDragEnd 분기)는 그대로
유지된다. 바뀐 것은 드래그 **중의 피드백**이고, 두 가지 사실을 정정한다.

### 정정 ①: ⠿ 핸들은 없다

헤더 **전체**가 드래그 활성 영역이다(`data-draggable`, `cursor-grab`). 헤더 안의
chevron·정렬·⋯ 버튼 클릭은 `PointerSensor` 의 `distance: 5` 가 드래그와 갈라 준다.
`WatchlistDrawer.drag.test.tsx` 의 "핸들 아이콘 없이 헤더 전체" 테스트가 이를 고정한다.

### 정정 ②: "그룹 블록 transform 이 이미 적절하다" 는 틀렸다

폴더 드래그에 고스트를 주지 않는 결정(구현 주석에 그 문구로 남아 있었다)이 실측으로
뒤집혔다(사용자 dev 서버 :5173, 그룹 5개 · 블록 129~579px · 패널 뷰포트 622px).

- 오버레이 껍데기(`RailDragOverlay`)는 드래그 종류와 무관하게 **항상 마운트**된다.
  children 이 `null` 이어도 래퍼는 액티브 노드 크기를 갖고 남으므로, **280×129 빈
  카드**(`innerHTML` 길이 0)가 커서를 따라왔다.
- 그 래퍼의 존재만으로 dnd-kit sortable 의
  `useDragOverlay = Boolean(dragOverlay.rect !== null)` 가 참이 되고,
  `shouldDisplaceDragSource = !useDragOverlay && isDragging` 가 거짓이 된다 → 액티브
  블록이 포인터 transform 이 아니라 **정렬 전략 transform** 을 받는다. 포인터 330px 에
  블록 733px 점프.
- 끌던 블록의 `z-index: 1` 은 이웃 그룹 sticky 헤더(`z-10`, 부모가 `static` 이라 루트
  스태킹)보다 **아래**라, 지나가는 헤더 밑으로 미끄러졌다.

### 결정

1. **폴더 고스트 = 헤더 한 줄 칩**(그룹명 + 개수). 블록 클론이 아닌 이유는 크기가
   아니라 정보다 — 22종목 그룹 클론은 패널 높이의 93% 를 가린다. 래퍼 **높이만**
   내용에 맞추고(`fitContentHeight`) 폭은 남긴다: 폭을 줄이면 칩이 아래 원본 행보다
   좁아져 원본 우측이 삐져나온 이중상이 된다(실측).
2. **z-index 30** — 헤더의 `z-10`/`z-20` 위, 헤더 내부 메뉴(`z-30`, 헤더가 만든
   스태킹 컨텍스트 안이라 지역값)와 겹치지 않는 루트 레벨 값.
3. **그룹 드래그 중에는 전 그룹을 헤더만 남기고 접는다.** `verticalListSortingStrategy`
   + `closestCenter` 는 균일 높이 리스트를 전제하는데 블록 높이가 129~579px 로 갈려
   있어, 129px 그룹을 579px 그룹 위로 보내려면 중심이 만날 때까지 ~500px 을 끄는 동안
   화면이 멎어 있었다. 접으면 29px × N 으로 균일해지고 5개 그룹이 145px 에 들어와
   스크롤 없이 재배치 결과 전체가 보인다(실측: 한 칸 이동이 733px → 58px 이동, 칩·포인터·
   미리보기가 같은 좌표에 겹친다). dnd-kit 공식 sortable-tree 예제와 같은 수법.
   - 저장된 접힘 상태(`watchlist.collapsed`)는 **건드리지 않는다** — 렌더 시점
     오버라이드라, 드래그가 끝나면 사용자가 펼쳐 두었던 그룹이 그대로 돌아온다.
   - 접힘은 종목 행(=droppable)을 언마운트하므로 드롭 타깃 rect 를 다시 재야 한다.
     `RemeasureOnCollapse` 가 `measureDroppableContainers([])` 를 한 번 요청한다.
     전역 `MeasuringStrategy.Always` 는 쓰지 않는다 — 드래그가 아닐 때도 1초마다 전
     droppable 을 재서 패널이 열려 있는 내내 비용을 낸다.
   - **비용**: 드래그 시작 순간 리스트가 접히면서, 아래쪽 그룹을 잡았으면 커서가 짧아진
     리스트 바깥에 남는다. 칩이 커서에 붙어 있고 충돌 판정도 칩 기준이라 조작은
     성립하지만, 시작 시점의 점프는 남는다. 트랜지션을 걸지 않는 이유도 같다 —
     높이 애니메이션은 rect 재측정과 경합만 한다.
