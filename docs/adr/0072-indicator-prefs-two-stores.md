# 0072 — 지표 prefs 두 store(livePage·chartPrefs)는 통합하지 않는다

**Status:** accepted (2026-06-13)

**Related:**
- `state/livePage.ts` (`live.indicators.v1`) — 지표 on/off + MA config.
- `state/chartPrefs.ts` (`hoga.chart.prefs.v1`) — 동작설정 레지스트리(`CHART_TOGGLES`/`CHART_NUMERIC_PREFS`, ADR-0027).
- 2026-06-13 호가 3종 「지표」 모달 편입 후 아키텍처 리뷰에서 "두 store 통합" 후보가 제기됨.

## Decision

한 지표의 prefs가 두 store에 나뉘어 있지만(예: 호가비 = `livePage.ratioEnabled` + `chartPrefs.ratioOutlierFilterEnabled` + `chartPrefs.ratioOutlierThreshold`), 두 store를 **하나로 통합하지 않는다.** 분리를 유지한다.

## Context

호가 동작설정을 ⚙️ 설정 모달에서 「지표」 모달로 옮기며(2026-06-13) 한 지표의 설정이 두 store를 오가는 게 더 눈에 띄게 됐고, 아키텍처 리뷰가 "통합"을 후보로 올렸다. 그러나 두 store는 **다른 관심사**를 담는다:

- **`livePage` (`live.indicators.v1`)**: "어떤 지표를 켜나" + 그 지표의 표시 config(MA 슬롯 배열·색/두께, 매도벽 스타일). imperative persist(각 setter가 `persistIndicators` 호출, 전체 슬라이스 직렬화).
- **`chartPrefs` (`hoga.chart.prefs.v1`)**: "차트가 어떻게 동작하나" 동작 knob(급증 마커 문턱·극단값 필터·누적선·동시호가 마스킹). 선언적 레지스트리에서 타입·기본값·persistence 자동 파생(ADR-0027), debounce 구독 persist.

## Alternatives considered

### A. 분리 유지 (채택)
deletion test상 통합은 복잡도를 **집중**시키지 않고 **이동**시킨다 — 두 종류의 prefs는 여전히 필요하다. 마찰("한 지표를 알려면 두 번 조회")은 경미하고, 분리는 "켜짐(livePage)" vs "동작(chartPrefs)"이라는 진짜 관심사 경계를 반영한다. ADR-0069(분석설정 전역)는 globalness만 정하고 단일 store를 요구하지 않는다.

### B. 단일 store로 통합 (기각)
blast radius가 매우 크다: 두 persistence 포맷(`live.indicators.v1`·`hoga.chart.prefs.v1`)의 마이그레이션 + 모든 소비자 변경. reversibility 낮음. 두 store의 persist 메커니즘(imperative vs 레지스트리-debounce)도 다르다. 통합 이득(조회 한 번)이 그 비용을 정당화하지 못한다 — premature unification.

## Consequences

**Positive:** 두 관심사가 독립적으로 진화. persistence 포맷 안정. chartPrefs는 레지스트리 파생을 유지, livePage는 자기 형태를 유지.

**Negative / watch:** 한 지표의 "전체 설정"을 다루는 코드(리셋·export·일관성 검증)는 두 store를 읽어야 한다. **재검토 트리거**: (1) `livePage` 지표가 chartPrefs와 동형의 선언적 레지스트리(`INDICATOR_TOGGLES`)로 마이그레이션되어 두 레지스트리가 같은 모양이 될 때 — 그때 "지표 → 그 지표의 모든 키" 인덱스나 통합이 저비용이 된다. 그 전에는 분리가 옳다.
