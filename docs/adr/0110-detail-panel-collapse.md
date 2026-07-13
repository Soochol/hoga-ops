# 0110 — /live·/study 우측 상세 패널 접기(카드 개별 + 패널 전체)

**Status:** accepted (2026-07-13)

**Related:**
- ADR-0022 — (superseded) /replay 런타임 사이드바 폭·collapsed 플래그. /replay 제거로 코드는 삭제됐고, 여기서 레일 패턴을 새로 만든다.
- ADR-0040 — Live SSE는 LivePage 단일 소유. 사이드바/카드는 소비자라 언마운트해도 스트림 불변.
- ADR-0047 — 상세 스택에서 "체결" 카드 제거(밀도 확보) — 같은 "세로 공간 아끼기" 계열.

## Context

`/live`·`/study` 우측 상세 패널의 지표 카드(10호가·거래원·매물대·프로그램·잠정투자자)는
접을 수 없었다. 데이터 없는 카드("호가 데이터 없음" 등)도 세로 공간을 차지해 차트를
넓게 볼 방법이 없었다. 요구: (1) 카드를 헤더만 남기고 개별 접기, (2) 패널 전체를 얇은
레일로 접기. 접힌 카드 헤더엔 "데이터 없음" 점만 표시.

## Decision

### 1. `DataSection` 접기 opt-in

`ui/DataSurface.tsx`의 `DataSection`에 `onToggleCollapse`를 넘기면 헤더 전체가 토글
버튼이 되고, 안 넘기면(나머지 6개 호출부) 기존 정적 헤더 그대로 렌더한다. 접힘 시
본문을 **unmount** — SSE 틱마다 도는 테이블 재렌더가 멈추는 성능 이득이 접기의
숨은 효용이다. chevron은 `ui/ChevronIcon.tsx`로 추출하고 관심종목·히트맵 드로어의
로컬 사본을 이 프리미티브로 이관했다(히트맵 사본의 "watchlist를 안 건드리려는" 근거는
중립 ui/ 모듈이 생기며 소멸). 접힘은 아래 화살표를 -90° 회전(150ms)해 얻는다. 높이는
스냅(무애니메이션, DESIGN.md).

### 2. weights 보존 + inert 리사이저

접기는 `rightCardWeights`를 파괴하지 않는다 → 펴면 이전 비율 복원. 이웃 카드가 접히면
그 사이 리사이저를 **숨기지 않고 inert**(pointerdown 미부착, `aria-disabled`)로 만든다.
이유: "정확히 4개 separator"를 단언하는 기존 테스트와 grid의 `card 8px card …` 행 정렬을
보존. 접힌 grid 행은 `min-content`로 둔다 — `auto`면 `align-content: stretch`가 빈 헤더를
뷰포트 높이까지 늘린다.

### 3. 빈 상태 점 = 언게이트 입력으로 판정

접힌 카드 헤더의 "데이터 없음" 점은 **원천 입력**으로 계산한다(orderbook 스냅샷 유무,
broker 시리즈 길이, program points, investor rows, 매물대는 persisted 프로필/캔들 유무).
매물대 훅은 접힘 시 `enabled:false`로 꺼져 출력이 공허하게 비므로, 게이트된 출력으로
판정하면 점이 거짓말한다 → 반드시 언게이트 입력을 본다.

### 4. 영속화 — additive, 엔트리별 관대 검증

`live.layout.v1`에 `rightCardCollapsed`(부분 맵) + `detailPanelCollapsed`를 **버전 범프
없이** 추가. 구↔신 payload는 누락 필드=기본값으로 양방향 degrade. `study.layout.v1`
신설(/study 최초의 레이아웃 상태). 접힘 맵은 weights의 all-or-nothing 검증과 달리
**엔트리별**로 검증(손상 엔트리 하나가 전체 맵을 날리지 않도록). 모든 setter는 단일
`persistFromState` 헬퍼를 거친다 — 각 setter가 payload를 수동 조립하면 새 필드를 빠뜨려
조용히 유실시킨다.

### 5. 패널 전체 접기 = 레일 (신규)

`detailPanelVisible = !isIndexInstrument && !detailPanelCollapsed`. 접힘 시 스플리터+패널
대신 28px 세로 레일 버튼(«, "상세")을 렌더하고, `rightPanelWidthPx`는 건드리지 않아
펴면 이전 폭 복원. 지수 종목은 레일도 안 나온다(패널 자체가 없음). 단축키 **`d`**(양
페이지; `w`=관심종목 선례, 드로잉 단축키는 Alt/Ctrl 게이트라 충돌 없음). `/study`는
메모가 접힌 aside 안에 살아, 메모 열 때 `setDetailPanelCollapsed(false)` 자동 호출.

## Consequences

- 데이터 없는 카드를 접으면 그 공간이 살아있는 카드/차트로 넘어간다. 접힌 카드는
  본문 unmount + 매물대 훅 게이트로 실제 계산도 멈춘다(화면만 넓어지는 게 아니라 가벼워짐).
- `/study`가 처음으로 레이아웃 상태를 갖는다(`study.layout.v1`).
- 접힘/펼침은 새로고침·탭 전환에도 유지된다.
