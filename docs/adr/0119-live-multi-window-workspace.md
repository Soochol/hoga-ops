# 0119 — `/live` 멀티창 워크스페이스 (스마트 자석 플로팅)

**Status:** draft (2026-07-19) — PR-A 착지. wayfinder 지도
[#706](https://github.com/Soochol/hoga-ops/issues/706) 최종 스펙
[#715](https://github.com/Soochol/hoga-ops/issues/715)의 구현. ADR-0114가 보류한
"자유 2D 위젯 그리드 (Phase 3)"를 실현한다.

## Context — 왜 멀티창인가

`/live`는 지금까지 **단일 차트 + 세로 pane 스택 + 우측 카드 열**의 고정 레이아웃이었다.
사용자는 차트·보조지표를 독립 창처럼 자유롭게 추가/삭제·이동·리사이즈하고, 같은 종목을
여러 봉으로 나란히 보며, 창을 숫자(1~10)로 묶어 종목을 연동하기를 원했다.

현 구조에는 이 요구를 막는 세 벽이 있었다(2026-07-19 탐색 확정):

1. **단일 lightweight-charts 인스턴스** — 페이지당 1개(`LiveChartRoot`), 지표 "창"은 그
   내부 pane. 축·크로스헤어 동기화가 단일 인스턴스라 공짜였다.
2. **singleton 이름 키** — `PaneId` union + boolean 토글. 순서·크기·설정·드로잉이 전부
   이름 키라 "같은 것 2개" 개념이 없었다.
3. **단일 `activeCode`** — 렌더 SSOT(ADR-0113/0052), WS 구독 1·bundle 1.

이 개편은 버그 수정이 아니라 **모델 변경**이다. 되돌리기 비용이 크므로, 아이디어를
wayfinder 지도(티켓 9장)로 정리해 각 결정을 티켓 해소로 확정한 뒤 착수한다.

**Related:**
- ADR-0114 — 워크스페이스 순서 레이어·레이아웃 프리셋. 본 ADR이 그 "Phase 3 보류"를 실현.
  `keyOrder`(안정 키 순서)·프리셋 계약을 계승/확장한다.
- ADR-0113 — `/live` 단일 뷰 복귀. `activeCode` writer만 교체한 전례 — 본 ADR은 그 **역방향**
  (reader 호환층: `activeCode = groupSymbols[activeGroup]`)으로 15곳의 읽기를 무변경 유지한다.
- ADR-0052 — `activeCode` 렌더 SSOT. 활성 그룹의 종목으로 대체되지만 SSOT 위치·계약은 유지.
- ADR-0028 — 드로잉 pane 바인딩(안정 `PaneId`). 드로잉은 **종목 귀속**으로 확장(같은 종목
  창끼리 공유).
- ADR-0072 — 지표 prefs 2-store 분리. 창별 소유로 이관(창당 `live.indicators.v2` 한 벌).

## Decision

### 1. 패러다임 = 스마트 자석 플로팅 (#707)

자유 좌표·겹침 허용의 플로팅에 현대화를 얹는다. 토스식 그리드 도킹·타일링을 검토했으나,
요구의 "자석"·"경계선 리사이즈"·"밀려남"을 하나로 만족하는 건 자석 플로팅이었다(인터랙티브
프로토타입으로 사용자 검증).

- **자석**: 이동·리사이즈 중 이웃 가장자리·정렬선·화면 경계에 임계 `SNAP_THRESHOLD`(12px)로
  흡착, accent 가이드라인 표시. 후보 우선순위 = 인접 > 정렬 > 경계(near-tie 에서만 갈림).
  `Alt` = 흡착 해제.
- **붙은 경계 = 스플리터 승격**: 인접(±2px)·겹치는 창들의 공유 경계를 순수 변(e/w/n/s)으로
  드래그하면 양쪽이 동시 조절된다. 붙이면 타일처럼, 떼면 플로팅. 이웃이 최소 크기(`MIN_W`
  160/`MIN_H` 120)에 닿으면 드래그 변도 함께 멈춘다(follower MIN 클램프).
- **엣지 스냅존**: 화면 좌/우 벽으로 끌면 반분할. **Tidy**: 원클릭 타일 정렬(안전망).
- **포커스**: z-order 최상단 + `shadow-modal`, 비포커스 `shadow-panel`.

스냅 엔진은 기성 라이브러리로 "붙은 경계 동시 리사이즈"를 표현할 수 없어(#710) **자체 구현**한다.

### 2. 창 타입 2종 (#708)

- **차트 창** = 캔들 + 보조지표 pane 스택(현 `LiveChartRoot` 통째) = lightweight-charts
  **인스턴스 1개/창**. 창 내부 pane 축·크로스헤어 동기화는 단일 인스턴스가 보장.
- **데이터 창** = 비차트 패널 각각(10호가·거래원·매물대·프로그램·잠정투자자). 시간축 없음 →
  창 간 동기화 무관. **우측 상세 패널(카드 세로 스택)은 폐지**하고 전부 창으로 이주(앱 전역
  레일·관심종목·알림은 크롬으로 존속).
- 차트 창은 **완전 독립·무제한 중복**(창별 timeframe — 같은 종목 1분봉+일봉 나란히가 1급).
- **창 간 동기화 = 같은 링크 그룹 차트 창끼리 크로스헤어 시간만**(lwc `subscribeCrosshairMove`
  → `setCrosshairPosition`). 팬/줌·뷰포트는 창별 독립.

### 3. 링크 그룹 = 종목 SSOT (#711)

- 그룹 1~10, 각 그룹이 종목 하나를 가리키고 소속 창 전부가 그 종목을 표시. **연동은 종목뿐**.
- **활성 그룹 = 마지막 포커스 창의 그룹**(파생, 비저장). 전역 진입점(TopNav 검색·관심종목
  클릭)과 전역 표시(하단 시장지표 바·알림)는 활성 그룹 기준.
- **종목 드래그&드롭**: 관심종목·스크리너에서 창 위에 드롭 → 그 창의 그룹 종목 교체(포커스 무관).
- **무소속 창 없음**, 새 창 = 활성 그룹 상속. 종목 고정은 빈 그룹 번호 전용으로.

### 4. 인스턴스화 — 인스턴스 차원은 "창"에만 (#712)

- 한 차트 창 안은 **지표당 pane 1개** 유지 → 창 내부는 기존 `PaneId` 체계 무변경 재사용.
  "같은 지표 다른 설정"은 차트 창 추가로 충족. 키 스키마 = 창 id × `PaneId`.
- **설정 소유권 = 창**: 각 차트 창이 `live.indicators.v2` 구조(paneOrder+paneStretch+per-timeframe
  4버킷 sparse) 한 벌을 소유. 병합은 2층(공장값 ⊕ 창) 유지(전역 ⊕ 창 3층안 기각).
- **새 차트 창 = 포커스 차트 창 복제.**
- **드로잉 = 종목 귀속**, 같은 종목을 보는 모든 차트 창에 표시(#708의 잠정 "창 귀속"을 뒤집음).

### 5. 영속화·마이그레이션 (#713)

- **범위 = `/live` 전용.** `/study`는 현행 유지, 워크스페이스 전환은 live 선 검증 후 별도 효력.
- 신규 키 `live.workspace.v1` = { windows[] (id·kind·group·rect·chart?), zOrder[], groupSymbols }.
  뷰포트는 비저장(현행 관례 — 낡은 뷰포트 복원 버그 회피).
- 구 키 1회 시드 후 미사용: `live.page.v1`·`live.indicators.v2`·`live.layout.v1` → 창 시드.
  공장 레이아웃 = 현행 화면 재현. 프리셋 v3(schema 2→3, 종목 포함 전체 스냅샷, v2 자동 이관).

## Implementation — PR 분할

| PR | 내용 | 상태 |
|---|---|---|
| **A** | 스냅 엔진 + `WorkspaceCanvas`/`WindowFrame` + `live.workspace.v1` 스토어(더미 콘텐츠) + 본 ADR | ✅ 착지 |
| **B** | `WindowViewContext` 신설, 데이터 페치 경로 전역 직독 교체(기능 무변경). context 기본값 = 기존 전역 동작 → `/study` 무변경 보장 | ✅ 착지 |
| **C** | 차트 창 N개 + 데이터 창 이주 + 상세 패널 폐지 + 마이그레이션 시드 | 🚧 증분 진행 (C1 마이그레이션 시드 ✅ · 렌더 컷오버 예정) |
| **D** | 링크 그룹 — groupSymbols·뱃지 팔레트·드래그&드롭·크로스헤어 버스·활성 그룹 전역 배선·WS venue 전송 | 예정 |
| **E** | 프리셋 v3 + 성능 마감(비포커스 창 스로틀·스냅존·Tidy·단축키) | 예정 |

### PR-A 착지 범위

- `frontend/src/live/workspace/snapEngine.ts` — 순수 스냅 로직(이동·8방향 리사이즈·스플리터
  승격·follower MIN 클램프·반분할 스냅존). 단위 테스트로 전 분기 고정.
- `frontend/src/live/workspace/tidy.ts` — Tidy 배치 순수 함수.
- `frontend/src/live/workspace/WorkspaceCanvas.tsx` — 포인터 → 엔진 위임. 드래그 중 로컬
  preview 렌더, 드롭 시 rect 커밋(#710 성능). 커밋은 ref(진실)에서 읽어 state 플러시 타이밍에
  의존하지 않는다.
- `frontend/src/live/workspace/WindowFrame.tsx` — 창 크롬(헤더·8핸들·팔레트·포커스 그림자).
- `frontend/src/state/workspace.ts` — `live.workspace.v1` 스토어(관대한 per-entry 검증,
  `persistFromState` 단일 깔때기).
- dev 전용 프리뷰 라우트 `/workspace-preview`(PR-C 가 `/live` 배선 시 제거).

### PR-B 착지 범위

- `frontend/src/live/workspace/windowView.ts` — `WindowViewContext` + `useWindowView()`
  (code·timeframe·historicalFromDate·group) + `useWindowIndicators()`(resolve 된
  IndicatorSettings). **Provider 밖에서는 전역 `useLivePageStore` 로 폴백** → 절단 자체가
  기능 무변경(아직 Provider 없음, PR-C 가 창별로 붙인다).
- 소비자 절단: `LivePage`(code·timeframe·historicalFromDate) · `useLiveBundle`(historicalFromDate
  + 지표 토글 9건, 전역 직독 10건 제거). 두 소비자가 데이터 페치 경로 전체를 창-파라미터화한다.
- 범위 밖(의도): venue 는 전역 유지(#715) · 크로스헤어/축 동기화는 PR-D · ambient 투영
  원본(`livePage.ts` indicatorTimeframe) 교체는 모델 변경이라 #712/PR-C · 저장뷰 소스는 PR-C/D.
- 검증: windowView 훅 단위 테스트(Provider→창값 · 폴백→전역) · useLiveBundle 기존 테스트
  전량 green(무변경 확인) · 전체 3891 green · `/live`·`/study` 도그푸딩 무변경.

### PR-C 착지 범위 (증분)

PR-C 는 실제 `/live` UX 를 바꾸는 대규모 작업이라 증분으로 착지한다.

- **C1 — 마이그레이션 시드 (✅)**: `frontend/src/state/workspaceMigration.ts` — 레거시 키
  (`live.page.v1`·`live.indicators.v2`·`live.layout.v1`)에서 초기 `live.workspace.v1` 을 1회
  시드하는 **순수 함수**(`buildWorkspaceSeed`) + 얇은 localStorage 래퍼. `workspace.ts` 하이드
  레이션이 `live.workspace.v1` 부재 시 호출(없으면 공장 기본). 매핑: page.candleTimeframe →
  첫 차트 창 봉 · activeInstrument(주식) → 그룹 1 종목 · indicators.v2 → 첫 차트 창 지표 ·
  layout 카드 순서·숨김 → 데이터 창(숨김 제외, 순서 보존). 워크스페이스 스토어는
  `/workspace-preview`(DEV lazy)에서만 로드되므로 `/live`·`/study` 영향 0. 순수 시드 9케이스 +
  스토어 통합 2케이스 TDD, `/browse` 도그푸딩(레거시 시드 → 창·종목·순서·숨김 확인).
- **C2a — 파이프라인 훅 추출 (✅)**: `frontend/src/live/useLiveChartData.ts` — LivePage 의
  인라인 ~130줄 데이터 파이프라인(useLiveSeries + useLiveBundle + 지수 번들 + ask/bid peaks +
  trade-volume POC + liveSaveBundle + workarea 파생)을 **창별 재사용 가능한 훅**으로 추출.
  LivePage 는 활성 뷰로 호출해 **기능 무변경**(behavior-preserving refactor), ChartWindow(C2b)가
  창의 값으로 같은 훅을 호출 — 두 번째 소비자를 만들되 로직 중복 없음. 검증: 전체 3902 green
  (테스트 수 불변=순수 이동)·LiveWorkarea/useLiveBundle/LivePage 테스트 green·eslint debt 순증
  0(impure `Date.now`·setState-in-effect 는 LivePage 기존 debt 의 relocation)·`/live` 도그푸딩
  무변경("Rendered fewer/more hooks" 없음=훅 순서 보존).
- **C2b — 차트 창 실 콘텐츠·시맨틱 활성화 (✅)**: `frontend/src/live/workspace/ChartWindow.tsx` —
  창의 (group→종목, timeframe, indicators)로 `useLiveChartData` 창별 파이프라인을 돌리고 실제
  `LiveChartRoot` 를 렌더. **Provider 경계 처리**: 바깥 `ChartWindow`(Provider 설정) + 안쪽
  `ChartWindowInner`(Provider 자식에서 훅 호출) 2-컴포넌트 — 안쪽 useWindowView/useWindowIndicators
  와 nested useLiveBundle 이 창의 값을 본다(**시맨틱 첫 활성화**). WorkspaceCanvas 가 chart-kind
  창에 배선(데이터 창은 아직 더미). 검증: `/workspace-preview` 도그푸딩 — 실 삼성전자 차트(캔들·MA·
  거래량·드로잉 레일·peaks) 렌더, **차트 창 2개 = LiveChartRoot 2인스턴스·24 캔버스 독립 공존**
  (다중 인스턴스 핵심 미지수 해소), JS 에러 0(hook·infinite-loop 없음)·전체 3902 green. **알려진
  한계**: LiveChartRoot 의 pane 렌더(어느 지표 pane·paneOrder)와 드로잉 `activeTool`(전역)은 아직
  전역 스토어 직독(#709 cut #7 부류, 후속 PR) — 데이터 페치는 창별이나 pane 표시·활성 도구는 전역
  공유. code-review 결함 0(Provider 경계·prop 매핑·훅 안전·다중 인스턴스·investorNet 5축 통과).
- **C2c-1 — 데이터 창 실 콘텐츠 (✅)**: `frontend/src/live/workspace/DataWindow.tsx` — 비차트 창에
  실제 사이드바 카드를 **LATEST 모드**로 렌더. kind 별 하위 컴포넌트(조건부 훅 회피): `BookWindow`
  (useLiveSeries→OrderbookTable+TotalQtyBar)·`BrokerWindow`(useLiveSeries→BrokerTrajectoryTable)·
  `InvestorWindow`(useLiveInvestorTrendEstimate→InvestorTrendEstimateCard). 크로스윈도우 커서(hover
  스팟)는 PR-D. 프로그램·매물대는 번들(timeframe) 종속이라 차트 창 연동(PR-D) 후 — C2c-1 은 안내 카드.
  검증: `/workspace-preview` 도그푸딩 — 호가/거래원 실 카드(빈 백엔드라 빈 상태 우아 처리)·잠정투자자
  실 데이터 렌더, 크래시 0·전체 3902 green.
- **C2c-2 — `/live` 플립 (스펙 확정 2026-07-19, [#715 코멘트](https://github.com/Soochol/hoga-ops/issues/715#issuecomment-5016017318))**:
  grilling 으로 확정한 5증분(2a~2e). **2a 지표 쓰기 경로** — 워크스페이스 스토어에 창별 지표
  setter(`patchChartIndicators`·`setChartTimeframe`·`setChartPaneOrder`·`setChartPaneStretch`·
  `resetChartIndicators`·`applyChartIndicatorPreset`, sparse=공장값 diff 재사용) + windowView
  컨텍스트 쓰기 경로 + `useIndicatorActions()`(이름 setter 표면 재구성, Provider 밖=전역 폴백
  → `/study` 무변경) + MA 슬롯 도메인 로직 순수 함수 공유 + **cut #7 지표 읽기 절단 동봉**
  (LiveChartRoot 지표/paneOrder/paneStretch·MA/일봉MA 오버레이 — 드로어 쓰기와 한 몸).
  **2b 드로잉** — 변이 op code-명시 리팩터(전역 activeCode 경유 오귀속 결함 차단), activeTool
  전역 유지. **2c 크롬 부품** — 상태바=포커스 차트 창 발행(studySaveSource 패턴), 봉 컨트롤
  창 내부 이동, 고정 통합 툴바(창 추가·정리·지표·설정·수집·저장뷰·프리셋), `GroupSymbol.kind:
  'stock'|'index'`(지수 정식 지원). **2d 플립** — LivePage 셸 교체, liveNavigate→활성 그룹
  `setGroupSymbol` + livePage 미러링(레거시 읽기 15곳 호환층), 드로어=포커스 차트 창 실시간
  추적, Shift+숫자=포커스 창, 프리셋 v2=포커스 창 적용, 시드 즉시 persist, `/workspace-preview`
  제거. **2e** — 상세패널 계열 데드코드 삭제(별도 커밋). 설정 드로어·chartPrefs·venue 는 전역
  유지.

**성능 실증**: lightweight-charts `^5.2.0`에 autoSize/ResizeObserver 리사이즈 지터 수정이
포함(#710) — 드래그 중 라이브 리사이즈가 프레임 저하 없이 동작(프로토타입 12창·6인스턴스 확인).

**리뷰 반영(2차, adversarial 13건 확정)**: tidyLayout MIN 플로어 + 열 수 폭-캡(정리가
sub-MIN 겹침 타일을 영속화하는 결함 수정) · computeResize 밴드 역전 가드(sub-MIN follower 가
드래그 창을 자기 MIN 아래로 밀지 못함) · 링크 팔레트 외부클릭/Escape 닫기(`useDismissablePopover`)
+ 팔레트 열 때 창 raise(contain:paint 스택 컨텍스트 occlusion 해소) · 프리뷰 라우트 lazy+DEV
게이트(프로덕션 번들에서 워크스페이스 트리셰이크 확인) · 차트 창 복제 시 indicators 신선 사본
(참조 공유 금지) · w/s/n follower·detectFollowers w/n·mode n·Y축 흡착·차트 하이드레이션 등
커버리지 공백 테스트 보강(39→53 케이스).

## Consequences

- 되돌리기 비용: PR-A는 순수 additive(기존 배선 무변경, 전체 테스트 그린) — 스캐폴딩이라
  되돌리기 비용 ~0. 실제 위험은 PR-B(전역 직독 절단)에 격리.
- `/study`는 PR-B의 context 기본값(전역 동작)으로 무변경 유지. 워크스페이스 전환은 후속.
- 프로토타입(`claude/proto-magnet-floating-workspace`)은 폐기 전제 — 스냅 엔진만 프로덕션으로
  재작성 이식했다(직접 승격 금지).
