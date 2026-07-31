# 0132 — 히트맵 한 종목 다중 그룹 등록: entry 정체성을 (folder_id, code)로

**Status:** accepted (2026-07-31)

**Related:**
- ADR-0112 — 히트맵 미분류 폐지(v3, folder_id 필수). 이 ADR은 그 결정의 **암묵적 따름
  정리**였던 "한 종목 = 최대 한 그룹"을 개정한다. folder_id 필수는 그대로 유지된다.
- ADR-0070 — watchlist v3 멀티멤버십. watchlist 는 이미 한 종목이 여러 폴더에 속한다
  (`folder.member_codes`). 히트맵도 같은 성질을 갖되 **저장 모양은 다르다**(아래 참조).
- ADR-0068 — 히트맵 독립 스토어. 여전히 독립 — 이 변경은 watchlist 를 건드리지 않는다.
- ADR-0097 — 히트맵 REST 30s 수집. 수집 대상은 **코드 집합**이라 등록 수가 늘어도
  대상은 늘지 않는다(dedup 책임이 호출자에게 있음을 명문화).

## Context

히트맵 엔트리는 `entries[]` 안에서 `code`가 사실상 기본키였다. `add_entry_to_folder`가
"없으면 추가, **있으면 그 폴더로 이동**"이었고, `remove_entry(code)` / `move_entries(codes)`
도 code 하나만 받았다. 그래서 같은 종목을 두 그룹에서 보고 싶다는 요구가 구조적으로
불가능했다 — 한쪽에 추가하면 다른 쪽에서 사라졌다.

## Decision

**엔트리 정체성은 `(folder_id, code)` 쌍이다.** 한 종목은 여러 그룹에 동시 등록될 수
있고, **한 그룹 안에서는 여전히 한 번만** 등록된다.

1. **추가는 추가다.** `add_entry_to_folder` 는 다른 그룹의 등록을 옮기지 않는다. 같은
   그룹에 다시 추가하면 멱등(이름만 갱신, 순서 유지) — 더블클릭이 행을 복제하거나
   그룹 순서를 흔들지 않는다.
2. **단일 등록을 겨냥하는 커맨드는 폴더를 받는다.**
   - `DELETE /api/heatmap/folders/{folder_id}/members/{code}` — 그 그룹에서만 해제(신설).
     UI 의 행 삭제·⋯메뉴가 쓰는 표면.
   - `DELETE /api/heatmap/{code}` — 모든 그룹에서 해제(유지, "히트맵에서 완전 제거").
   - `POST /api/heatmap/move` 는 `from_folder_id` **필수**. 없으면 어느 등록을 옮길지
     정해지지 않으므로 서버가 추측하는 대신 422 로 거절한다.
3. **도착 그룹에 이미 있으면 이동은 붕괴한다.** 한 그룹은 같은 코드를 한 번만 담으므로
   출발 등록이 사라질 뿐 중복 행이 생기지 않는다.
3-1. **Ctrl+드래그 = 복제, 그냥 드래그 = 이동.** 복제에 새 서버 커맨드는 없다 — 다중 그룹
   등록이 허용된 뒤로 "그 그룹에 추가"(`add_entry_to_folder`)가 곧 복제다. 수정자 판정은
   `useCopyDragIntent` 한 곳: `onDragStart` 의 `activatorEvent.ctrlKey` 로 시드하고(“Ctrl 을
   먼저 누르고 끌기”의 keydown 은 드래그 시작 **전**이라 리스너가 못 본다), 드래그 중에는
   window 키 리스너로 갱신한다. 드롭존 색이 accent(이동)/success(복제)로 갈려, 놓기 전에
   어느 쪽인지 보인다.
4. **스키마 버전은 3 그대로.** 디스크 모양(`entries[]`)이 바뀌지 않았고, v4 로 올리면
   구버전 빌드가 `UnsupportedHeatmapSchema` 로 **읽기 자체를 거부한다**(ADR-0065 의
   loud-halt). 중복 등록이 든 파일을 구버전이 읽으면 그냥 두 그룹에 렌더될 뿐이라,
   버전을 올리는 쪽이 더 파괴적이다. 대신 `HeatmapDocument` 에 (folder_id, code) 유일성
   검증을, `_migrate` 에 같은 키 중복 제거(first-wins)를 넣는다 — 마이그레이션에서
   dangling 두 행이 같은 미분류로 구조될 때 문서 전체가 "손상"으로 격리되는 것을 막는다.

**watchlist 의 `member_codes` 모양을 따르지 않은 이유:** 히트맵은 그룹 내 순서(`order`)와
그룹별 표시 이름을 엔트리에 들고 있어, 멤버십을 폴더로 옮기면 순서 저장소를 따로 만들어야
한다. 평평한 `entries[]` 에 (folder_id, code) 쌍을 허용하는 쪽이 `_reindex`·`reorder_entries`
·드래그 재정렬을 **전부 그대로** 남긴다. ADR-0068 의 "클론하되 일반화하지 않는다" 노선과도
일치한다.

## Consequences

- **코드 집합을 쓰는 소비처는 dedup 필수.** `load_heatmap` 은 등록 단위 목록이다.
  `live/coverage.py`(이미 `dict.fromkeys`), `screener_universe`·`screener_depth`(set/
  `setdefault`)는 이미 안전했고, 프론트의 시세 구독 코드 목록(`/heatmap` 페이지·드로어)에
  `new Set` 을 넣었다.
- **행 dnd id 가 복합키가 된다** — `entrySortableId(folderId, code)`(watchlist 멀티멤버십이
  ADR-0070 에서 이미 쓰던 공유 코덱). 한 DndContext 안에서 code 만 쓰면 같은 종목의 두 그룹
  행이 같은 id 가 되어 dnd-kit 이 경고 없이 엉뚱한 행을 움직인다.
- **보드의 DndContext 가 폴더별 → 보드 전체 하나로 바뀐다.** 폴더별 컨텍스트는 드래그를
  구조적으로 "그룹 내"에 가뒀다(그래서 보드에는 그룹 간 드래그가 아예 없었다). 이제 보드도
  드로어와 같은 계약이다: 형제 행 위=그룹 내 재정렬(manual 정렬일 때만), 다른 그룹 블록
  위=이동/복제(모든 정렬 모드). multicol 은 문제되지 않는다 — 폴더 블록이 break-inside-avoid
  라 한 칼럼 안에 온전하고, dnd-kit 은 좌표로 충돌을 잰다.
- **드롭 하이라이트는 `useDroppable().isOver` 로 판정하면 안 된다.** manual 정렬이면 행 자체가
  droppable 이라, 대상 그룹의 **행 위**를 지나는 동안 그룹 존의 isOver 는 꺼진다 — 정작 거기서
  놓으면 그 그룹으로 들어가는데 하이라이트는 사라져 있다. 컨텍스트의 현재 `over` 가 어느
  폴더에 속하는지로 판정한다(추가 리렌더 없음 — useDroppable 도 같은 컨텍스트를 구독한다).
- **`/live` 타이틀바 그룹 칩은 여러 이름을 잇는다** (`heatmapGroupNameOf` → "반도체 · 대형주").
  첫 등록만 보면 나머지 소속이 화면에서 사라진다.
- **그룹 삭제는 여전히 파괴적이되 그룹 스코프다** — 같은 종목이 다른 그룹에 있으면
  히트맵에서 사라지지 않는다(ADR-0112 의 confirm 문구는 그대로 유효: 그 그룹의 종목 수).
