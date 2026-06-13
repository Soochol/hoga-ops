# 0074 — 두 /live MA 오버레이의 series-reconcile 공유 추출은 보류한다

**Status:** accepted (2026-06-13)

**Related:**
- ADR-0046 (`/live` 이동평균선 = 자체 overlay; "두 번째 지표 시점까지 unify 미룸")
- ADR-0071 (카테고리 2단 패널 = 공유 셸로 추출하지 않음)
- ADR-0072 (지표 prefs 두 store = 통합하지 않음)
- ADR-0073 (일봉 이동평균선 분봉 투영)

## Decision

`MovingAverageOverlay`(현재봉)와 `DailyMovingAverageOverlay`(일봉)는 **id-keyed LineSeries
reconcile**(add/remove/applyOptions + unmount cleanup, ~50줄)를 거의 동일하게 중복한다 —
"두 어댑터 = 실재 seam"의 교과서적 사례. 그럼에도 이 공통부를 **공유 Module로 추출하지
않고** 두 오버레이에 각자 유지한다.

단, 일봉 MA의 **순수 입력 계산**(lookback 창·거래일→캘린더일 환산·오늘 현재가 프록시)은
`live/indicators/dailyMaProjection.ts`로 **추출했다** — 그쪽은 오버레이 본문에 묻혀
fetch mock 뒤라 테스트가 닿지 못했고(그래서 period>190 lookback 미달 버그가 통과했다),
deep seam으로 빼니 직접 검증된다. 즉 **"입력 계산"은 추출(testable 이득 명확), "series
생명주기 보일러플레이트"는 보류(이득 marginal·리스크 존재)** 로 갈랐다.

## Why (series-reconcile 추출을 보류)

- **안정 코드 리스크 > 중복 제거 이득**: 추출하려면 이미 출하·리뷰·테스트된 안정적
  `MovingAverageOverlay`를 신규 Module에 의존시켜야 한다. 작동하는 코드를 DRY 목적으로
  리팩터하는 건 중복이 *실제로 아플 때*만 정당.
- **마찰이 아직 안 아픔**: 미러는 일봉 MA(ADR-0073)로 방금 1회 생겼을 뿐. "두 곳을 고쳐야
  하는 비용"은 고칠 series-lifecycle 버그가 생기기 전엔 가설.
- **팀 grain 일관**: ADR-0046/0071/0072가 반복 명시한 anti-premature-consolidation 성향과
  동일선. (직접 가드는 아니나 결이 같다.)
- **비대칭 비용**: `maSeriesRegistry`에 현재봉만 register(레전드)·일봉은 미등록(ADR-0073
  v1 비대상). 공유 Module은 이 비대칭을 조건/콜백으로 흡수해야 해 "깨끗한 공유" 이득이
  침식된다.

## Trigger Conditions

(미래에 본 ADR을 supersede하고 공유 Module 추출을 재검토할 조건)

- **세 번째 MA류 LineSeries 오버레이**가 등장(예: 상위TF 다른 종류 라인) → 어댑터 3개면
  공유가 분명히 값을 한다.
- **series-lifecycle 버그를 양쪽 오버레이에 똑같이 고쳐야 하는 순간** → 그때 비로소
  fix-once(locality)가 비용을 회수한다.
- **`maSeriesRegistry`를 일봉에도 연동**(ADR-0073의 Pane Legend trigger 발동)해 두 오버레이의
  레지스트리 비대칭이 사라질 때 → 공유 Module 인터페이스가 깨끗해진다.
