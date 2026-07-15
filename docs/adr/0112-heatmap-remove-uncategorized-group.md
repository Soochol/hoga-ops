# 0112 — 히트맵 미분류(null 그룹) 폐지: folder_id 필수 + 파괴적 그룹 삭제 (heatmap.json v3)

**Status:** accepted (2026-07-15)

**Related:**
- ADR-0068 — 히트맵 독립 스토어. 이 ADR이 그 결정 중 두 가지를 **개정**한다: (a) G3의
  "미분류(folder_id=null) render-only 그룹 표시", (b) 그룹 삭제의 비파괴 reparent.
- ADR-0070 — watchlist v3 멀티멤버십. "미분류 add target 없음 + 폴더 삭제는 고아 종목
  파괴적 삭제(confirm)"를 먼저 확립했다 — 본 ADR은 히트맵을 같은 문법으로 정렬한다.
- ADR-0004 — Wire Model = consumer shape. "미분류 = 합성 폴더 없는 render-only 그룹"
  패턴의 원 출처; 히트맵에서는 이 패턴 자체가 사라진다(watchlist grouping 제네릭에는 잔존).
- ADR-0065 — forward-migrate, never quarantine. v2→v3 마이그레이션이 따르는 거버넌스.
- ADR-0097 — 히트맵 REST 30s 수집. "entry SET 변경 라우트만 resync 훅" 계약에서
  delete-folder 가 folder-shape 목록에서 **빠져나온다**(멤버 삭제로 SET 이 줄어들 수 있음).

## Context

히트맵은 watchlist v2 시절 구조를 클론(ADR-0068)한 뒤 독립 진화했고, 그 결과
`folder_id: str | null`의 null 상태 — "미분류" render-only 그룹 — 가 남아 있었다:

- 그룹 삭제가 멤버를 미분류로 reparent(비파괴, confirm 없음),
- 드로어 헤더 "종목 추가"가 그룹 없이 미분류로 추가,
- 미분류를 숨기면 "추가했는데 안 보임" 사일런트 버그라 표시 강제(ADR-0068 상호잠금).

사용자 결정: **미분류라는 개념을 제거한다. 삭제된 그룹과 그 종목은 그냥 사라진다.**
watchlist 는 이미 v3(ADR-0070)에서 같은 결론에 도달했다.

## Decision

**모든 히트맵 종목은 실폴더에 속한다.** `HeatmapEntry.folder_id`는 필수(`str`),
`heatmap.json`은 schema_version 3.

1. **그룹 삭제 = 파괴적.** `delete_folder`는 폴더와 멤버 종목을 함께 지운다. UI(드로어
   ⋯ 메뉴)는 멤버가 있으면 `window.confirm`("'{이름}' 그룹과 종목 N개가 함께 삭제됩니다")
   — watchlist 삭제와 동일 문법. 빈 그룹은 confirm 없이 즉시. entry SET 이 줄어들 수
   있으므로 delete-folder 라우트에 storage-target resync 훅(ADR-0097)을 추가한다.

2. **추가는 폴더 지정만.** 폴더 없는 `add_entry` + `POST /api/heatmap`(미분류 추가)를
   제거한다. 유일한 추가 커맨드는 `add_entry_to_folder`(`POST /folders/{id}/members`,
   있으면 이동). 드로어 헤더 "종목 추가" 팝오버에 그룹 셀렉트(기본=첫 그룹)를 넣고,
   그룹이 0개면 "먼저 그룹을 만들어 주세요" 안내 + 추가 비활성.

3. **와이어에서 null 거부.** `/api/heatmap/move`는 히트맵 전용 요청 모델
   (`HeatmapEntriesMoveRequest`, folder_id 필수)로 null 목적지를 422 로 거부한다.
   reorder 는 이미 v3 watchlist 계약(`EntriesReorderRequest.folder_id: str`)이었다.

4. **v2→v3 마이그레이션(읽기 경로, ADR-0065).** null(또는 dangling) folder_id 종목은
   결정론적 id `f_00000000`, 이름 "미분류"의 **일반 폴더**를 만들어 수용한다 — 이후
   이름변경·삭제가 자유롭고 다시 자동 생성되지 않는다(개념은 사라지고 이름만 마이그레이션
   흔적으로 1회 남는다). id 가 결정론적인 이유: load 는 디스크에 쓰지 않으므로(다음
   mutation 이 저장) 랜덤 id 면 로드마다 바뀌어 프론트 접기상태(폴더 id 키)가 흔들린다.
   watchlist v3 시드가 verbatim 복사된 heatmap.json 은 `f_00000000`("기본")을 이미 가질
   수 있다 — 그 경우 새 폴더를 만들지 않고 기존 폴더 멤버 **뒤에** 병합한다.
   `schema_version > 3`은 loud halt(`UnsupportedHeatmapSchema`).

5. **프론트: null 분기 전면 제거.** `HeatmapEntry.folder_id: string`,
   히트맵 전용 `HeatmapGroup { folder: HeatmapFolder; entries }` + `groupHeatmapEntries`
   신설(공유 `groupByFolder`의 null 그룹 push 를 우회). 보드/드로어/행 메뉴/섹터 스트립의
   미분류 라벨·정렬 특례·드롭존·이동 타깃을 제거. `/heatmap` 페이지 빈 상태는
   "종목 0 && 그룹 0"일 때만 — 그룹만 있는 상태에서 ＋새 그룹·툴바가 막히면 안 된다
   (v3 는 그룹이 있어야 종목을 추가할 수 있으므로).

## Consequences

- 삭제 안전성이 **구조(비파괴 reparent)에서 절차(confirm)로** 이동한다. 히트맵 종목은
  캡처 이력 같은 부속 데이터가 없어(모니터링 전용) 재추가 비용이 낮고, watchlist v3 가
  이미 같은 트레이드오프를 채택했다.
- ADR-0068 의 "미분류 가시성 ↔ 시드 상호잠금"은 전제(추가가 미분류로 먼저 들어감)가
  사라지며 함께 소멸한다.
- `hoga/live/index_sector_rankings.py`의 "미분류" 폴백 라벨은 사문화되어 제거(이름 결측
  시 id 노출 폴백만 방어적으로 유지).
- 이전 버전 백엔드는 v3 파일을 읽으면 loud halt 한다(다운그레이드 비지원 — ADR-0065 계열
  의도된 동작).
