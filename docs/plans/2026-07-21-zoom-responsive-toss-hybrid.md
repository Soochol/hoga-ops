# 줌/좁은 폭 대응 — 토스식 하이브리드 플랜

브라우저 줌인(= CSS 유효 뷰포트 축소)과 좁은 창에서 앱이 "전문가 웹"처럼 버티게
하는 플랜. 전략은 토스증권 주문 페이지 실측(2026-07-21)과 4-변형 프로토타입
비교(`/prototype/zoom-responsive`, 변형 D 채택)로 확정했다.

**방침 한 줄: 코어(차트·호가·체결)는 유동 압축까지만 허용하고 절대 접지 않는다.
접는 건 주변부뿐. 그래도 모자라면 바닥(min-width) + 가로 스크롤로 도망간다.**

줌 감지 코드는 어디에도 없다 — 줌인은 유효 폭 축소와 동일하므로 폭 반응형이
줌 반응형을 겸한다(`visualViewport.scale` 분기 금지).

---

## 근거 실측

**토스증권** (`tossinvest.com/stocks/*/order`, /browse 1600→600px 스윕):

- `html { min-width: 1024px }` 한 줄이 바닥. 600px 뷰포트에서도 문서 폭 1024 고정
  → 가로 스크롤.
- 바닥~와이드 구간: 패널 열 유지 + flex 유동 압축(주문 유형 텍스트 3줄 감김,
  % 버튼 축소). 브레이크포인트 리디자인 없음.
- 접히는 건 주변부(관심 워치리스트 → 아이콘 레일)뿐. 코어(차트·호가·주문) 불가침.
- root font-size 16px 고정(rem 다이얼 없음), 줌 대응 전용 코드 없음.

**프로토타입** (`frontend/src/prototype/ZoomResponsivePrototype.tsx`, dev 전용
라우트 — main 머지 금지, throwaway 브랜치로 보존 예정):

- A(우선순위 접기: 코어까지 압축) vs B(고정 바닥) vs C(유동 스택) vs
  D(토스식 하이브리드) 비교 → **D 채택**.
- D 바닥 실측: 스트립 36 + 차트 380(봉 몸통 가독 하한) + 호가 260(7ch 가격+잔량바)
  + 체결 200 + gap/패딩 24 ≈ **900px** (주문 패널 없는 우리 코어 기준).
- 유동 압축의 비용 확인: 946px에서 가격 스트립 종목명이 2줄로 감김 → 압축 구간
  컴팩트 규칙 필요(기존 `chartHeaderCompact` 패턴 재사용).

## 현황 (2026-07-21)

- **브레이크포인트 부재**: `@media`는 `prefers-reduced-motion` 1개뿐. Tailwind
  반응형 프리픽스 사용 파일 1개. 레이아웃은 고정 데스크톱 grid — 줌인 시 눌리다
  깨지는 지점이 설계가 아니라 우연.
- **셸**(`App.tsx`): `grid h-screen w-screen overflow-hidden`, 열
  `1fr [panel] var(--rail-w)`, 행 `minmax(0,1fr)`. 바닥 없음 — 뷰포트가 줄면
  1fr(main)이 무한 압축된다. `overflow-hidden`이라 잘린 콘텐츠는 도달 불가.
- **/live 캔버스**: 창 = px rect(`state/workspace.ts` WorkspaceRect,
  `snapEngine` MIN_W 160/MIN_H 120). 캔버스 축소 시 자동 re-clamp 없음 —
  줌인하면 창이 캔버스 밖으로 나가 도달 불가(수동 Tidy 만 구제).
- **주변부 접기 인프라는 이미 존재**: RightRail 아이콘 레일, 드로어 개폐
  (`state/rightRail`), 상세패널 접기 레일(ADR-0110), 드로어 전체 접기.
  폭 조건과 연결만 안 돼 있다.
- **컨테이너 폭 기반 컴팩트 선례 존재**: `workspace/chartHeaderCompact.ts` +
  `useChartHeaderCompact` — 차트 창 헤더가 자기 폭에 따라 단계 축약. 압축 구간
  컴팩트 규칙은 이 패턴을 확장하면 된다.
- **grid 축 비대칭 전과**: 한쪽 축만 `minmax(0,1fr)`로 리사이즈 잘림 4곳 수정
  이력(2026-07-20). 줌인은 이 버그 계열의 최빈 재현 경로.
- root font-size 18px rem 다이얼(DESIGN.md Scale Factor). 밀도 토글은 백로그 —
  이 플랜과 별개 트랙이나, 바닥+스크롤 채택 시 "글자만 키우고 싶다" 수요의
  정답이 밀도 토글이 된다는 점만 기록.

---

## PR-1. 바닥 선언 + 가로 스크롤 (셸)

**목표**: 유효 폭 < 바닥에서 레이아웃이 눌려 깨지는 대신 가로 스크롤로 전환.

- 바닥 값: **1024px** (토스와 동일; FHD 187% 줌·1440 노트북 140% 줌까지 무손상).
  코어 실측 900 + 셸 크롬(rail `--rail-w` + gap) 여유를 덮는다. `tokens.css`에
  `--app-floor: 1024px` 토큰으로 선언.
- **스코프 = 셸 전역 단일값, 페이지별 예외 없음.** 바닥을 결정하는 건 페이지
  콘텐츠가 아니라 **모든 라우트가 공유하는 셸 크롬**이다 — TopNav(로고+6 nav+
  Settings+WS 상태)와 RightRail 은 어느 페이지에나 있고, 780px 실측에서 TopNav
  "Capture" 항목이 이미 잘렸다. `/settings`·`/capture` 처럼 콘텐츠만 보면 더
  좁게도 접히는 페이지가 있지만, 셸이 먼저 깨지므로 페이지별 바닥은 복잡도만
  늘고 실익이 없다. 셸(`App.tsx`)이 `<Outlet/>` 으로 전 라우트를 감싸므로
  선언 1곳이 전 페이지에 전파된다(새 라우트 추가 시 누락 위험 0).
- 메커니즘: 토스처럼 `html`에 직접 걸면 셸 grid가 `w-screen`(100vw)이라 잘린
  부분이 빈 화면이 된다. 우리 구조에선:
  - `App.tsx` 셸 grid: `w-screen` → `w-full min-w-[var(--app-floor)]`
  - `html`(global.css): `overflow-x: auto` 허용 (현재 셸이 `overflow-hidden`으로
    문서 스크롤을 막고 있으므로 html/body 레벨에서 풀어준다)
  - 스크롤바: `scrollbar-width: thin` + 토큰 색. 바닥 이상에선 아예 안 생기므로
    정상 사용 화면 변화 0.
- 가드 테스트: 뷰포트 800px 렌더에서 `document.documentElement.scrollWidth >=
  1024` && 셸 grid 폭 `>= 1024` 단언(#730 계열 회귀 방지와 동형).
- DESIGN.md에 "Responsive floor" 절 추가 + ADR 신설(바닥 정책: 값·근거·스코프).

## PR-2. 유동 압축 견고성 감사 (Tier 1)

**목표**: 바닥~와이드 구간(1024~1600)에서 모든 페이지가 잘림·겹침 없이 압축.

- grid 축 비대칭 재감사: `minmax` 사용처(`StudyPage` 5곳, `BookPanel`,
  `ChartDrawingShell`, `IndexSectorRankingPane`)와 셸 하위 flex 자식 `min-w-0`
  누락 스캔. 과거 4곳 수정과 같은 패턴.
- 압축 구간 컴팩트 규칙: 실측에서 깨지는 곳에만 최소 적용. 프로토타입에서 확인된
  후보 = 가격 스트립(종목명 말줄임), 이후 /browse 스윕에서 발견분 추가.
  구현은 `chartHeaderCompact` 패턴(컨테이너 폭 기반, 미디어쿼리 아님).
- 검증: /browse `viewport` 스윕 — 800·1024·1140·1280·1600 × 주요 라우트
  (/live·/study·/screener·/heatmap·/inventory·/capture·/settings) 스크린샷 +
  `console --errors`. 페이지 자체 가로 스크롤은 바닥 미달에서만 허용.

## PR-3. 주변부 자동 접기

**목표**: 1024~1140 구간에서 코어 공간을 지키기 위해 주변부가 스스로 물러남.

- 대상은 **셸 주변부만**: 우측 드로어(관심/히트맵/스크리너/저장뷰/알림)가 열려
  있으면 유효 폭 < 임계(제안 1280: 드로어 `--watchlist-panel-w` + 코어 바닥)에서
  자동 닫힘. 사용자가 그 폭에서 다시 열면 존중(세션 내 재자동닫힘 금지 —
  1회성 양보, 토스의 관심 레일과 동일한 감각).
- 구현: 셸 레벨 `useEffect` + matchMedia(값은 토큰 파생) → `rightRail` 스토어
  close. CSS 미디어쿼리가 아니라 스토어 경유인 이유: 드로어 상태가 이미 스토어
  소유물이고, "사용자 재열기 존중" 상태가 필요해서.
- `MarketIndexBar` 축약은 실측 후 필요 시에만(현재도 auto 행이라 데이터 없으면
  0으로 접힘).

## PR-4. /live 캔버스 바닥 + 창 도달성

> **착지 시 정정(2026-07-21).** 아래 초안은 "바닥 덕에 최악 케이스가 스크롤하면
> 보임으로 격하된다"고 가정했는데 **틀렸다**. 캔버스는 `overflow-hidden` 이라
> 셸에 가로 스크롤이 생겨도 캔버스 밖 창에는 못 닿는다 — 뷰포트 1026px 에서
> 캔버스 972×638 vs 창 extent 1428×776 실측(3창 중 3창 도달 불가).
> 캔버스에 스크롤을 주는 안은 기각: 드래그/스냅 좌표계(`clientX - canvasLeft`)와
> Tidy 가 캔버스 폭을 진실로 쓰고 있어, 캔버스가 콘텐츠만큼 넓어지면 Tidy 가
> 넓어진 폭으로 정리해 되돌아오지 않는 **래칫**이 생긴다.
> 착지한 것은 **어포던스**다: 캔버스 밖 창을 감지해 하단 중앙에 "창 N개가 화면
> 밖에 있습니다 · 정리" 를 띄운다. 자동 이동은 여전히 없다(창 배치는 사용자
> 소유물, ADR-0119) — 없앤 것은 "조용한 소실"뿐이다.

**목표**: 줌인으로 캔버스가 줄어도 창이 "사라지지" 않게.

- `WorkspaceCanvas` 래퍼에 `min-width: var(--app-floor)` 상속 + 가로 스크롤
  (PR-1의 셸 스크롤로 자연 획득되는지 실측 후, 캔버스 자체 스크롤 필요 시 추가).
- 캔버스 축소 시 off-canvas 창: 바닥 덕에 최악 케이스가 "스크롤하면 보임"으로
  격하되므로 자동 re-clamp 는 도입하지 않는다(창 배치는 사용자 소유물 — 자동
  이동은 ADR-0119 정신에 반함). 대신 캔버스 폭 < 창 extents 감지 시 상태바에
  "Tidy 제안" 1회 노출만 검토(선택 항목).
- 차트 창: 압축 후 봉 몸통 px 검증(CLAUDE.md /live 일봉 절차 —
  `timeScale().width()`·visible span·dpr). `LiveChartRoot.test.tsx` +
  `npm run build` 통과.

## 백로그 연계 (이 플랜 밖)

- **밀도 토글**(Compact 1.0×/Comfortable 1.125×/Cozy 1.25×, DESIGN.md 백로그):
  바닥+스크롤 채택 시 "글자만 키우고 싶은" 사용자의 정답. 차트 리마운트 이슈
  포함 별도 플랜.
- 프로토타입 정리: 변형 D 채택 기록 후 `ZoomResponsivePrototype.tsx` + main.tsx
  라우트 블록을 throwaway 브랜치로 이동, main 에서 제거.

## 검증 총괄

각 PR 공통: /browse viewport 스윕(800/1024/1140/1280/1600) 스크린샷 비교,
`console --errors` 클린, `cd frontend && npx vitest run` 관련 스위트,
`npm run build`. 데스크톱 크롬 실줌(Ctrl+/−, dpr 변화 포함) 도그푸딩은 PR-1·4
착지 후 1회.
