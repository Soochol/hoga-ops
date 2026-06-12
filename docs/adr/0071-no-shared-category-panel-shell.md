# 0071 — 카테고리 2단 패널(IndicatorPanel·설정)은 공유 셸로 추출하지 않는다

**Status:** accepted (2026-06-12)

**Related:**
- `LiveSettingsModal`/`LiveSettingsSections`(2026-06-12, 총잔량 급증 설정) — 설정을 IndicatorPanel과
  동일한 "왼쪽 카테고리 nav + 오른쪽 상세 (ModalShell)" 2단 레이아웃으로 재구성하며 생긴 중복.
- `live/indicators/IndicatorPanel.tsx` — 그 형태의 선행 구현.

## Decision

`/live`에 "왼쪽 카테고리 nav + 오른쪽 상세 패널(ModalShell)" 형태의 모달이 둘 — **IndicatorPanel**(지표)와
**설정**(`LiveSettingsModal`+`LiveSettingsSections`) — 존재하지만, 공유 셸 Module로 **추출하지 않는다.** 둘은
같은 레이아웃 *형태*를 띠되 독립적으로 유지한다.

## Context

표면상 DRY 위반(2단 패널 코드 둘)이라 아키텍처 리뷰가 "공유 `CategoryNavPanel` 셸로 추출"을 제안하기 쉽다.
실제로 측정하면 **공유 표면이 얇고 가변 표면이 크다**:

- 공유분: flex 레이아웃 + `w-[200px]` nav + 선택 `useState` + ModalShell — 작다.
- 가변분(크다): IndicatorPanel의 nav 행은 **체크박스(마스터 토글) + 라벨(상세 네비) + 비활성 placeholder**이고
  상세는 지표별 config 컴포넌트(MA/Volume/InvestorNet…). 설정의 nav 행은 **평범한 카테고리 선택**이고 상세는
  `CHART_TOGGLES` 레지스트리에서 도출한 토글/numeric 행. 둘은 다른 축으로 진화한다.

## Alternatives considered

### A. 그대로 둠 (채택)
"중복은 잘못된 추상화보다 싸다"(Metz). 공유분이 작아 추출 이득이 낮고, 두 패널의 nav 행위·상세가 독립
진화하므로 공유 셸로 묶으면 한쪽 변경이 다른 쪽을 건드려 **locality가 나빠진다**. 세 번째 카테고리 패널 계획
없음(YAGNI). blast radius도 낮음(동작·테스트 끝난 IndicatorPanel을 안 건드림).

### B. 공유 `CategoryNavPanel` 셸 추출 (기각)
`{ categories, selected, onSelect, renderDetail }` 인터페이스로 레이아웃·선택을 한 Module에 집중. 진짜
세 번째 패널이 생기거나 두 패널의 nav 행위가 수렴하면 그때 가치가 생긴다 — **지금은 premature abstraction**.

## Consequences

**Positive:** 두 패널 각자 자유롭게 진화. 안정 컴포넌트(IndicatorPanel) 무위험.

**Negative / watch:** 레이아웃 토큰(nav 폭·간격)을 두 곳에서 손봐야 함. **재검토 트리거**: (1) 세 번째
카테고리 2단 패널이 필요해질 때, (2) 두 패널의 nav 행 구조가 수렴할 때 — 그 시점에 B를 다시 평가한다.
