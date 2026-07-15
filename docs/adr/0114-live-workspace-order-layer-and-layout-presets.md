# 0114 — `/live` 워크스페이스 사용자 소유 순서 레이어 + 레이아웃 프리셋

**Status:** accepted (2026-07-15) — PR A에서 신설, PR B·C에서 증보.

## Context

`/live`(및 `/study`)의 화면 구성은 코드가 고정한다:

- 차트 pane 순서 = `frontend/src/chart/paneSpecs.ts` 의 `PANE_SPECS` 배열 인덱스.
- 우측 상세 카드 순서 = `LiveDetailPanel`/`StudyReferenceDetailPanel` 의 하드코딩 배열.

사용자는 접기(ADR-0110)만 할 수 있고 **순서 변경·숨김·레이아웃 저장**이 불가했다. Toss식
커스터마이즈의 1단계로 (1) 사용자가 소유하는 순서 레이어 + 카드 숨김, (2) 백엔드 영속
레이아웃 프리셋을 도입한다. 자유 2D 위젯 그리드(Phase 3)는 이번 범위에서 보류한다.

**Related:**
- ADR-0109 — study-views JSON manifest 영속 패턴 (프리셋이 미러)
- ADR-0110 — 상세 패널 접기 · additive 영속(`live.layout.v1` 버전 범프 금지) · inert 리사이저
- ADR-0028 — `paneId`(= `PaneSpec.name`)는 드로잉 영속 안정 키 (순서 변경이 침범 금지)
- ADR-0072 — indicator prefs 2-store 분리 (`paneOrder` 는 `live.indicators.v1` 에 귀속)

## Decision

**1. 순서는 array index 가 아니라 안정 키 배열로 저장한다.** 공용 헬퍼
`frontend/src/state/keyOrder.ts` 가 규칙을 소유한다:

- `normalizeKeyOrder(raw, canonical, isKey)` — unknown 키 드롭, 중복 제거(첫 등장 유지),
  누락된 canonical 키는 canonical 순서로 뒤에 append. 이 규칙이 전방/후방 호환의 전부다:
  새 카드/pane 을 추가해도 구 저장값이 깨지지 않고, 삭제된 키는 조용히 사라진다.
- `reorderVisible(fullOrder, hidden, from, to)` — 보이는 부분수열만 재배열하고 숨김 키는
  전체 순서 내 절대 위치를 유지한다(복구 시 원래 자리로 돌아온다).

**멤버십은 여전히 코드/게이트가 소유한다.** 순서 레이어는 순열일 뿐이다 — pane 은
`paneSpecsForTimeframe` 의 게이트(분봉 전용 호가 pane, D 전용 투자자 pane)가, 카드는
가용성이 결정한다.

**2. 우측 상세 카드: 드래그 재배열 + 숨김/복구 (PR A).**
- `state/liveLayout.ts`(`live.layout.v1`)에 additive 확장: `rightCardOrder`(정규화 후 저장),
  `rightCardHidden`(per-entry 관대 검증). `state/studyLayout.ts`(`study.layout.v1`)에
  `cardOrder`/`cardHidden` 미러. 두 스토어의 단일 `persistFromState` 퍼널에 필드 편입.
- `LiveDetailPanel` 은 `cards` 배열 → `CARD_META` + `rightCardOrder` 파생 렌더. 리사이저는
  보이는 카드의 인접쌍에서 파생 — 기본 순서·숨김 없음이면 오늘과 동일한 4개 separator
  (라벨·testid 동일)를 재생산한다.
- 드래그: `@dnd-kit` sortable(기존 `StudyViewsDrawer` 패턴). `DataSection` 에
  `headerTrailing` prop 을 추가해 접기 토글 버튼과 **형제**로 드래그 핸들·숨김 버튼을 놓는다
  (헤더 클릭=접기와 충돌 방지).
- **hidden ≠ collapsed**: 숨김 = 카드 unmount(그리드 행·인접 리사이저 없음), 접힘 =
  헤더만 남김(본문 unmount). 둘 다 weights 를 파괴하지 않아 복구/펴기 시 이전 상태 복원.
  숨긴 카드는 컨트롤 행의 공용 `CardRestoreMenu`("+ 카드 추가")로 되살린다.

**3. 차트 pane: 레전드 ↑/↓ 재정렬, 캔들 고정 (PR B — 후속).**
- 전역 단일 `paneOrder`(per-timeframe 아님)를 `PersistedIndicators`(`live.indicators.v1`)에
  둔다. `paneSpecsForTimeframe(tf, toggles, paneOrder?)` 3번째 인자로 정렬 — 캐시 키가 이미
  정렬된 이름 join 이라 identity 안정성 유지(canonical/생략 시 `=== PANE_SPECS`).
- **캔들은 index 0 고정**(순서 대상 제외): timeScale/logical range 앵커이자 드로잉·오버레이가
  pane-0 컨텍스트를 가정하므로, 캔들 시리즈를 재생성하지 않아 뷰포트가 보존된다.
- 레전드 ↑/↓ 버튼은 **마운트된 이웃과 스왑** — 전체 순서에서 두 이름 위치 교환이라 게이트로
  부재중인 pane 을 자연스럽게 건너뛴다. 수용 비용: 스왑된 두 pane 이 remount(오늘의 pane
  토글과 같은 churn 클래스).

**4. 레이아웃 프리셋: 백엔드 영속 (PR C — 후속).**
- manifest `<data_dir>/live_layout_presets/saves.json`, study-views(ADR-0109) 패턴 미러
  (asyncio.Lock + `load_versioned_json_file` + `atomic_write_json`), `/api/live-layout-presets`
  CRUD.
- 프리셋 payload = paneOrder · panePrefsByTimeframe · indicator flags · 우측 패널 width/order/
  hidden/collapsed/weights. **종목·타임프레임·뷰포트는 미포함**(그건 study-views 의 역할이며,
  프리셋 전환이 보던 종목을 튕기지 않게 한다).
- 서버는 얕은 구조 검증만, 적용 시 프론트가 canonical 재정규화 — 새 pane/카드 추가에 백엔드
  무변경. 적용은 flat 레거시 pane 플래그와 `panePrefsByTimeframe` 를 **둘 다** 덮어써
  (`panePrefsForTimeframe` 이 두 레이어 병합이므로) 결정론을 확보한다. `lastAppliedPresetId`
  는 클라이언트 전용.

## Consequences

- 순서/숨김은 per-device(localStorage), 프리셋은 백엔드 공유 — 자연스러운 계층.
- pane 재정렬은 remount 를 유발하지만 캔들 불변이라 뷰포트는 안전.
- `keyOrder.ts` 정규화가 스키마 진화의 안전판 — 향후 카드/pane 추가는 canonical 배열에 한 줄.

## Rejected alternatives

- **per-timeframe paneOrder** — 게이트가 이미 멤버십을 해결하므로 순서는 전역 하나로 충분.
- **pane 드래그(v1)** — lwc 크로스헤어/드로잉 포인터 이벤트와 충돌 위험 → ↑/↓ 버튼으로 시작.
- **엄격한 서버 payload 스키마** — 새 지표 추가마다 백엔드 배포 결합 → 얕은 검증 + 클라 정규화.
- **`live.layout.v1` 버전 범프** — ADR-0110 의 additive 영속 원칙 위배 → 필드 추가로 해결.
