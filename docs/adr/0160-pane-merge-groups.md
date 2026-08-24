# 0160 — 보조지표 pane 병합: paneGroups 레이아웃 모델과 y축 3모드

**Status:** accepted (2026-08-24)

**Amends:**
- [ADR-0114](0114-live-workspace-order-layer-and-layout-presets.md) §3 — "paneOrder 는 사용자 소유 순열,
  멤버십은 게이트 소유". 원칙은 그대로 승계하되 레이아웃의 **원본이 순열에서
  순열+분할(`paneGroups`)로** 바뀐다. `paneOrder` 는 그 평탄화 **투영**으로 남는다.

**Related:**
- PR #1551(병합 코어) · #1553(축 공유 토글) · #1555(3모드·왼쪽 축·그룹 stretch).
- 설계 제안·목업: https://claude.ai/code/artifact/d38ada50-be9a-4dcc-98be-526b5051616d
- [ADR-0028](0028-drawing-pane-binding.md) — 드로잉 영속 키(PaneId). 병합은 이 키를 건드리지 않는다.
- [ADR-0159](0159-presets-carry-window-indicator-sets.md) — 프리셋은 전역 pane 레이아웃을 담지 않으므로 병합 상태는 프리셋
  적용에서 **생존**한다(조사로 확인 — "프리셋에 그룹 실기"는 불필요로 판정).
- `frontend/src/chart/paneGroups.ts`(모델·연산·축 정책) ·
  `frontend/src/live/paneGroupSpecs.ts`(게이트 분할·identity 캐시) ·
  `frontend/src/live/paneMergeDrag.ts`(드롭 판정) ·
  `frontend/src/chart/RangeSeriesPane.tsx`(`groupPaneIds`/`groupAxisMode`).

## Decision

1. **레이아웃 원본은 `paneGroups: PaneId[][]`** — 전체 PaneId 집합의 순열+분할이다.
   같은 그룹의 멤버들은 lightweight-charts 의 **같은 pane** 에 마운트된다.
   불변식: candle 은 단독 그룹 index 0 고정, 모든 PaneId 정확히 1회(누락은 canonical
   싱글턴 append), 빈 그룹 없음 — `normalizePaneGroups` 가 강제한다.
2. **`paneOrder` 는 평탄화 투영이고, 저장 블롭에는 둘 다 싣는다.** paneGroups 를
   모르는 구 빌드도 순서는 읽고, 구 빌드가 블롭을 재조립하면 groups 키가 통째로
   사라져 읽기가 싱글턴 파생으로 복귀한다 — 스테일 그룹이 남는 경로가 없다.
   **flat 순서 쓰기(`setPaneOrder`·프리셋 적용)는 그룹을 싱글턴으로 리셋한다** —
   flat 호출자는 병합 정보가 없으므로 순서가 곧 전체 레이아웃이다.
3. **멤버십은 여전히 타임프레임 게이트 소유다**(ADR-0114 §3 승계). 그룹은 레이아웃일
   뿐 — 현재 봉에서 게이트로 빠진 멤버는 마운트되지 않고, 전원 빠진 그룹은 pane
   자체가 생기지 않는다. 혼합 게이트 그룹(분봉 전용+D 전용)은 막지 않고 드롭 배너가
   "함께 표시되지 않습니다" 로 안내한다.
4. **렌더링은 지표당 `RangeSeriesPane` 1개, 같은 그룹 = 같은 `paneIndex`.** 병합
   PaneSpec 을 새로 만들지 않는다 — 각 멤버가 자기 `bundleKind` 그릇을 그대로 받아
   데이터 라우팅과 SSE memo 경계가 병합 전과 동일하다.
5. **`precedingPaneKey` 는 그룹 구성 시퀀스로 일반화된다** — pane 이름 하나가 아니라
   멤버 이름 join, 그리고 축 모드가 기본이 아니면 `!shared`/`!left` 플래그까지.
   그룹 내 멤버 증감·축 모드 플립은 그 pane 전 시리즈 재생성(= 일시적 빈 pane →
   lwc 자동 삭제 → 아래 인덱스 당김)을 부르므로, 아래 pane 들이 재생성에 참여해야
   한다(#1381 메커니즘의 그룹판).
6. **y축 기본값은 멤버별 격리 스케일이다.** 비대표 멤버의 시리즈는
   `merged:<paneId>:<원id>` 로 네임스페이스된다 — 'right' 만이 아니라 누적선
   오버레이(`''`)도 리매핑한다(lwc 는 같은 id = 같은 스케일이라 두 멤버의 누적선이
   오토스케일을 나눠 갖는다). 오른쪽 축 눈금은 첫 멤버(대표) 것이고 레전드 칩의
   「축」 배지가 소유를 표시한다. **"단위가 같으면 자동 공유" 는 채택하지 않는다** —
   거래량+총잔량이 반례다(둘 다 주 단위·0+ 인데 봉당 유량 vs 상시 수준이라 자릿수가
   달라, 공유하면 한쪽이 눌린다).
7. **축 공유 화이트리스트는 외국인+기관 1쌍으로 시작한다**(같은 주 단위·± 일별
   순매수·D 전용 — 직접 비교가 병합의 존재 이유인 조합만). 여기서 파생 집합을 만들
   때의 함정: co-display 판정(`panesCanCoDisplay`)은 게이트 지식을 복제하지 않고
   `paneSpecsForTimeframe(최대 토글)` 에서 파생하는데, **opt-in 게이트 pane 이 최대
   토글에서 빠지면 모든 병합 조합이 거짓 경고가 된다**(peak-wall 교차 PR 에서 실제
   발생). 전수 red 가드("모든 PaneId 는 어딘가에서 보인다")가 누락을 잡는다.
8. **그룹별 y축 모드는 3값이다: `isolated`(기본)·`shared`·`left`.** 'left' 는 대표가
   우축, **둘째 멤버가 좌축** 눈금을 갖는다(셋째부터 격리, 둘째의 `''` 오버레이도
   격리 유지). **좌축 컬럼의 렌더 게이트는 차트 레벨
   `chart.applyOptions({leftPriceScale:{visible}})` 다** — 시리즈를 'left' 스케일에
   얹고 pane 스케일 visible=true 를 줘도 width 0(실측). 컬럼 폭(실측 72px)은 차트
   전체 공유라 다른 pane 에 빈 거터가 생긴다 — 이 비용이 'left' 가 opt-in 인
   이유이고, 레전드 오버레이는 그 폭만큼 left 인셋을 민다.
9. **그룹 단위 오버라이드(축 모드·그룹 stretch)의 키 = 멤버 구성의 정렬 join**
   (`paneGroupKey`). 구성이 바뀌면 키가 달라져 선택이 **기본값으로 리셋**된다 —
   의도다: 새 멤버는 단위가 다를 수 있어 이전 선택을 이어받으면 안 된다. 정규화가
   현재 그룹과 매칭 안 되는 키를 걷어 스테일이 쌓이지 않는다(해체 시 자연 소멸).
   그룹 stretch 를 그룹 키에 저장하는 이유: 멤버 전원 기록(구판)은 분리 후 두 pane
   이 같은 크기로 시작하는 부작용이 있었다.
10. **UI 진입점은 레전드 이름 칩이다** — 드래그(pane 본체 = 병합, 경계 = 이동·분리,
    6px 임계값, Esc 취소)와 클릭 메뉴(비드래그 폴백: 병합/분리/축 모드). 드롭 존
    지오메트리는 레전드 Y 배치와 같은 소스(`chart.panes()` 누적)라 화면과 어긋날 수
    없다. 기존 ↑/↓(이제 그룹 전체 이동)·✕ 는 유지된다. 접기(`foldPanes`)의 원자
    단위는 그룹이다.
11. **드로잉(ADR-0028)은 무변경이다.** PaneId 는 지표별 영속 키로 병합에서 불변이고,
    각 멤버의 primary series 가 살아 있어 좌표 변환 매핑도 유지된다.

## Context

병합의 사용자 가치는 둘이다: 세로 공간(접기 압력 완화)과 **직접 비교**(외국인+기관
순매수량을 한 pane 에서). 구현의 갈림길은 "병합 pane 을 새 PaneSpec 으로 합성할
것인가, 기존 spec 들을 같은 paneIndex 에 겹칠 것인가"였고 후자를 골랐다 — 전자는
`bundleKind` 라우팅·SSE memo 경계·레전드 레지스트리를 전부 재배선해야 한다.

y축 규칙은 제안 단계에서 "단위·극성 매칭 자동 공유"가 검토됐다가 기각됐다(결정 6의
반례). 대신 기본 격리 + 화이트리스트 + 수동 3모드로 확정했고, 세 규칙 모두 이 리포의
기존 선례를 일반화한 것이다: 총잔량 매수/매도 = "같은 단위 두 시리즈 한 축",
거래량·체결강도의 누적선(`priceScaleId: ''`) = "다른 단위 시리즈, 같은 pane, 숨은
독립 스케일".

프리셋과의 관계는 조사로 닫았다: 레이아웃 프리셋(ADR-0159)은 창별 지표 세트만 담고
전역 pane 레이아웃(순서·그룹·stretch)은 원래 담지 않는다 — 따라서 병합 상태는
프리셋 적용에서 생존하고, "프리셋에 그룹 실기"는 존재하지 않는 문제였다.
`applyIndicatorPreset(paneOrder…)` 액션은 UI 진입점 없는 휴면 표면이며, 되살릴 때는
결정 2(flat 쓰기 = 싱글턴 리셋)가 적용된다.

## Consequences

- 새 pane 을 추가하면(`PaneId` 확장) 그룹 모델은 자동 편입된다 — canonical 싱글턴
  append. 단 **opt-in 게이트라면 `paneMergeDrag` 의 최대 토글에도 추가해야 한다**
  (결정 7 의 가드가 빨개진다).
- `RangeSeriesPane` 의 두 effect dep 목록에 `groupPaneIds`·`groupAxisMode` 가
  들어갔다 — 이 파일의 "한쪽에만 dep 추가" 반복 실패 유형에 두 축이 늘어난 셈이다.
- 축 공유 화이트리스트를 늘리려면 `SHARED_AXIS_SETS` 한 곳이다(멤버 전원이 한 세트
  안일 때만 발동).
