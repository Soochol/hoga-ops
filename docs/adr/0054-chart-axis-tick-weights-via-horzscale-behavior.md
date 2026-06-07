# 0054 — 차트 x축 tick-weight는 lightweight-charts HorzScaleBehavior 확장점에서 계산한다

**Status:** accepted (2026-05-30) — 구현은 spec/plan에서 추적

**Related:**
- `docs/superpowers/specs/2026-05-30-adaptive-x-axis-design.md` (설계 근거·대안 기각·번들 검증)
- `docs/superpowers/plans/2026-05-30-adaptive-x-axis.md` (구현 계획)
- **Virtual Axis** — `frontend/src/util/virtualAxis.ts` (CONTEXT.md "Virtual Axis"); 본 결정이 보완하는 갭-압축 시간축
- ADR-0041 — Live calendar-timeframe panes (D/W/M 타임프레임 분기의 출처)
- ADR-0045 — Spec declares invariants (spec ≠ ADR 역할 구분; 본 ADR이 그 규칙을 따르는 이유)
- CONTEXT.md 224행 — Virtual Axis 용어 정의가 tickMarkFormatter 세부를 "grill D4"로 명시 deferring → 본 ADR이 그 공백을 메운다

## Decision

`/live` 차트 x축의 **눈금 중요도(tick weight) 계산은 lightweight-charts의 `HorzScaleBehavior`
확장점을 서브클래싱**해서 수행한다. `defaultHorzScaleBehavior()`가 반환하는 클래스를 상속한
뒤 **`fillWeightsForPoints`만 오버라이드**하고, `createChart` 대신 `createChartEx(el, behavior,
options)`로 주입한다(`frontend/src/util/kstHorzScaleBehavior.ts`).

오버라이드는 각 포인트의 가상 초(`originalTime`)를 `axis.toReal()` + 9h로 **실제 KST 날짜**로
되돌린 뒤, 라이브러리 원본 `weightByTime`과 동일한 사다리(연 70 / 월 60 / 일 50 / intraday
divisor)로 weight를 매긴다. 그 결과 라이브러리의 **네이티브 줌-적응 티어 선택**(월→날짜→시간
자동 전환)·밀도 중재·라벨 겹침 회피가 재구현 없이 그대로 동작한다. `tickMarkFormatter`는
이제 올바른 `tickType`을 신뢰해 포맷만 한다.

**제약(load-bearing):** 오버라이드는 공개 필드 `originalTime`(읽기)·`timeWeight`(쓰기)만
사용한다. 내부 필드(`_internal_timestamp` → 프로덕션 미니파이 시 `.Sf`)는 절대 건드리지
않는다 — 건드리면 `vite build` 산출물에서 깨진다(dev/prod 번들 직접 대조로 검증, spec 참조).

## Why

차트는 야간 갭(15:30→익일 09:00)을 1초로 압축한 **Virtual Axis** 위에서 동작하므로, 캔들에
넘기는 `time`은 실제 Unix 초가 아니라 **가상 초(≈1970 epoch 근처)**다. lightweight-charts는
인접 두 시점의 `new Date(time*1000)`의 `getUTCFullYear/Month/Date`를 비교해 weight를 매기는데,
이 입력이 가상 초라 **가상 1970 달력** 기준으로 계산된다 → 월/일 경계가 실제 KST와 어긋나,
날짜 눈금이 세션 중간(예: 14:30)에 "05/28"로 찍히는 버그가 났다.

근본 원인이 **weight 계산의 입력 달력**이므로, 고칠 지점도 그곳이다. weight만 실제 KST 기준으로
바로잡으면 라이브러리의 줌-적응 로직 전체가 살아난다. 직전 우회(커밋 af6966f: 분봉 x축을 항상
HH:MM으로 고정하고 날짜는 DayBoundaryOverlay 칩이 담당)는 줌 적응을 원천 차단했는데, 본 결정은
그 우회를 제거해 오히려 코드가 단순해진다(칩도 제거, 날짜는 축이 소유).

### 대안과 기각 사유

- **tickMarkFormatter 안에서 실제 KST로 티어 직접 추론**: 라이브러리의 밀도 중재(공간에 맞춰
  어떤 눈금을 보일지 고르는 것)를 잃는다 — 그게 정확히 어려운 부분이다. weight를 소스에서
  고치는 정공법이 그 로직을 보존한다 → 기각.
- **실제 타임스탬프를 캔들에 그대로 피드**: 야간 갭이 시각적으로 되살아나 Virtual Axis의 존재
  이유를 무력화한다 → 기각.
- **전면 자작 HTML x축 오버레이**: 밀도·겹침·겹침회피·8자 제한을 전부 재구현해야 해 버그 표면이
  크다 → 기각.
- **HorzScaleBehavior 서브클래싱(채택)**: `createChart`가 이미 `createChartEx(el, new
  HorzScaleBehaviorTime(), …)`의 얇은 래퍼이고 `defaultHorzScaleBehavior()`가 그 클래스를 공개
  노출하므로, 라이브러리가 지원하는 확장점을 통해 weight 입력 달력만 교체한다. 티어 선택
  알고리즘(`maxTickMarkWeight` 등)은 상속해 손대지 않는다.

## 새 invariant

> 차트 x축 tick-weight는 `kstHorzScaleBehavior`의 `fillWeightsForPoints` 오버라이드에서, 가상 초를
> 실제 KST로 환산해 계산한다. 이 오버라이드는 lightweight-charts의 **공개 필드(`originalTime` /
> `timeWeight`)만** 사용한다 — 내부 필드(`_internal_*`, 미니파이 `.Sf`)에 접근하면 본 ADR 위반이며
> 프로덕션 번들에서 깨진다.

## Trade-off / consequences

- **라이브러리 내부 사다리 포팅**: weight 상수(70/60/50/divisor)는 lightweight-charts 원본
  `weightByTime`을 옮긴 것이라, 라이브러리가 알고리즘을 바꾸면 표류할 수 있다. 완화: 각 tier에
  인라인 주석, spec의 dev/prod 번들 검증 기록, 그리고 `kstHorzScaleBehavior.test.ts`의 회귀
  테스트(월/일/intraday 경계). 버전 핀(`^5.2.0` → `5.2.0`)은 spec의 Out-of-Scope 백로그.
- **타입 우회**: `createChartEx`의 옵션 타입이 behavior의 `options()` 반환에서 파생되므로,
  `options(): TimeChartOptions` 오버라이드 + 명시적 제네릭 `createChartEx<Time, …>`로
  `tickMarkFormatter`가 타입체크되게 한다. `setChart(c as IChartApi)` 캐스팅 1회. 런타임 무영향
  (주석 문서화).
- **로딩 중 근사**: `axis.segments`가 비었을 때(데이터 도착 전 플래시) `super`로 위임하지
  않는다 — base가 내부 필드를 읽기 때문. 대신 `originalTime`을 raw UTC 초로 취급한 무해한 근사를
  쓴다(라벨은 어차피 `''`).
- **부수 단순화**: 분봉 x축 "항상 HH:MM" 우회(af6966f) 제거, DayBoundaryOverlay의 MM/DD 칩 제거
  (세로 점선만 유지). 날짜 라벨 소유권이 칩 → 축으로 이동한다.

## Future signal to revisit

- lightweight-charts 메이저 업그레이드 시 — weight 사다리/`fillWeightsForPoints` 시그니처/공개
  필드명(`originalTime`/`timeWeight`)이 바뀌면 회귀 테스트가 시끄럽게 실패해야 한다(설계상 그렇게
  되어 있음).
- Virtual Axis가 갭 압축 방식을 바꾸면(예: 실제 시간축 도입) 본 확장의 전제(가상 초 입력)가
  사라지므로 재검토.

## Addendum (2026-06-07, v0.6.2.0) — real-anchored origin 도입 후에도 본 결정은 유효

`/live`는 이제 `createVirtualAxis(rawSegments, originMs)`에 첫 세션의 실제 개장 ms
(`segments[0].session_open_ms`)를 origin으로 넘긴다(**real-anchored origin**) — 가상 초가
1970 epoch 근처가 아니라 실제 epoch 근처가 됐다(위 Why의 "≈1970" 서술은 당시 기준으로 정확).
이는 본 ADR이 고친 버그(한 setData 세대 **안에서의** 가상-1970 달력 어긋남)와는 **다른**
스테일니스를 고친 것이다: lightweight-charts는 tick weight/mark/포맷된 라벨을 setData 세대를
넘어 time **값**으로 식별·보존하므로, zero-based 축이 재구성되면(leftward-pan prepend) 같은
가상 시각이 다른 실제 날짜로 재발급되어 과거 구간의 날짜 라벨이 이전 세대 것으로 남았다.
real-anchored origin은 prepend 시 인덱스 0의 time 값을 바꿔 lwc의 전체 rebuild를 강제한다.

본 결정(`fillWeightsForPoints`의 실제 KST 환산)은 origin과 무관하게(`axis.toReal()` 경유)
여전히 load-bearing이다: 갭 압축이 유지되는 한 segments[0] 이후의 세그먼트는 실제 시간 대비
일당 ~17.5h씩 당겨져 weight 입력 달력이 실제 KST와 계속 어긋난다. 위 "Future signal to
revisit"의 전제(가상 초 입력 — 내부 세그먼트에서 virtual ≠ real)는 사라지지 않았다.

같은 수정의 일부로: `kstHorzScaleBehavior`는 `cacheKey`를 추가 오버라이드해 축 세대를 키에
접어 넣어(origin-relative offset + `CACHE_GEN_STRIDE`) 세대 간 값 충돌이 라벨 LRU의 스테일
항목을 적중하지 못하게 하고, 교차 (code, timeframe) 뷰 충돌은 origin으로 분리할 수 없으므로
(예: W↔M이 같은 첫 거래일로 클램프) `LiveChartRoot`가 뷰마다 차트 인스턴스를 재생성하며,
`useLiveBundle`은 content-equal SSE push에서 `segments` 배열 identity를 재사용해 무의미한
축 세대 증가를 막는다.
