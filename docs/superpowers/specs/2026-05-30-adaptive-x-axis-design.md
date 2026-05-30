# Adaptive TradingView-style x-axis — /live minute chart — Design

**Date**: 2026-05-30
**Status**: Approved
**Scope**: frontend/src/util/kstHorzScaleBehavior.ts (new), frontend/src/live/LiveChartRoot.tsx, frontend/src/chart/DayBoundaryOverlay.tsx

## Problem

`/live` 분봉 차트의 x축은 현재 **항상 시간(HH:MM)만** 표시한다. 사용자 요청:

> "차트 zoom에 따라서 자동으로 월 첫날에는 5월 표기 / 날짜표기 / 시간표기 하는거 가능해? tradingview style로"

즉 줌 레벨에 따라 눈금 티어가 자동 전환되기를 원한다: 줌인 → `09:30`(시간), 줌아웃 →
`27`(날짜), 더 줌아웃 → `6월`(월).

### 근본 원인

차트는 lightweight-charts 5.2.0(TradingView 오픈소스)을 쓰지만, 야간 갭(15:30→익일 09:00,
약 17.5시간)을 1초로 압축한 **가상 축(Virtual Axis)** 위에서 동작한다
([virtualAxis.ts](../../../frontend/src/util/virtualAxis.ts)). 캔들 `time` 값은 실제 Unix 초가
아니라 `segments[0].sessionOpenMs` 기준 **가상 초(≈1970 epoch)**다.

lightweight-charts는 인접 두 시점의 `new Date(ts*1000)`의 `getUTCFullYear/Month/Date`를 비교해
눈금 **무게(weight)**를 매기고(`weightByTime`: Year=70 / Month=60 / Day=50 / 분·시 divisor),
그 weight로 줌별 티어(`TickMarkType`)를 자동 선택한다. 우리가 가상 초를 넘기므로 weight가
**가상 1970 달력** 기준으로 매겨진다 → 월/일 경계가 실제 KST와 어긋나, 날짜 눈금이 세션 중간(예:
14:30)에 "05/28"로 찍히는 버그가 났다. 커밋 `af6966f`는 이를 **분봉 x축은 무조건 HH:MM만 찍고,
날짜는 [DayBoundaryOverlay](../../../frontend/src/chart/DayBoundaryOverlay.tsx)의 세로 점선 +
MM/DD 칩이 담당**하도록 우회했다. 이 우회 때문에 줌 적응이 원천 불가능하다.

## Invariants

- **Virtual Axis spacing**: 캔들의 x 위치는 가상 축(갭 압축) 기준이며, 야간 갭이 화면에서 1초로
  보이는 성질은 보존되어야 한다. 근거: [virtualAxis.ts](../../../frontend/src/util/virtualAxis.ts).
- **Virtual↔real KST round-trip**: 축 라벨/툴팁은 `axis.toReal(virtualMs)` + 9h로 실제 KST를
  복원해 표기한다. 근거: [LiveChartRoot.tsx](../../../frontend/src/live/LiveChartRoot.tsx) 의
  기존 `timeFormatter`/`tickMarkFormatter`.
- **Day Boundary 위치 정합**: 세로 점선은 실제 세션 시작(09:00) 경계에 그려진다. 근거:
  [DayBoundaryOverlay.tsx](../../../frontend/src/chart/DayBoundaryOverlay.tsx).
- **Calendar(D/W/M) 날짜 표기**: D/W/M 차트는 DayBoundaryOverlay를 마운트하지 않으므로 x축이
  유일한 날짜 출처다. 일봉의 09:00 시각 라벨은 표기하지 않는다. 근거: 기존 `tickMarkFormatter`의
  `isCalendarTimeframe` 분기.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Virtual Axis spacing | preserves | weight 산정의 *입력 달력*만 바꾸고 캔들 `time`(위치)은 불변 |
| Virtual↔real KST round-trip | preserves | 동일 `toReal`+9h 변환을 weight 계산에도 동일 적용 |
| Day Boundary 위치 정합 | preserves | 세로 점선 로직 유지. 칩(span)만 제거 |
| Calendar 날짜 표기 | preserves | `tickMarkFormatter`의 calendar 분기에서 Time/TimeWithSeconds만 억제 |

*intentionally breaks 없음.* 이 spec은 버그 우회(af6966f)를 제거하고 근본 원인(가상 달력 weight)을
공식 확장점에서 고치는 변경으로, 위 invariant를 모두 보존한다.

## Goals

- 분봉 x축이 줌 레벨에 따라 **월→날짜→시간** 티어를 자동 전환(라이브러리 네이티브 밀도 중재 활용).
- 월 경계 첫 캔들에 `N월`, 일 경계에 날짜, 세션 내부는 시간 표기.
- af6966f의 "분봉=항상 HH:MM" 우회 코드 제거(순감 변경).
- dev/prod 빌드 양쪽에서 동작(공개 API에만 의존).

## Non-Goals

- 가상 축 자체의 재설계(갭 압축 방식 변경) — 범위 밖.
- 밀도 모드(Compact/Comfortable/Cozy) 도입 — 별도 작업.
- 날짜 포맷 로캘라이즈(영문 월 등) — 한국어 `N월` 고정.

## Design

### 접근: 커스텀 HorzScaleBehavior 주입 (createChartEx)

`createChart`는 내부적으로 `createChartEx(el, new HorzScaleBehaviorTime(), …)`의 얇은 래퍼다
(검증함). 공개 API `defaultHorzScaleBehavior()`가 그 클래스를 반환하므로, 이를 **서브클래싱해
`fillWeightsForPoints`만 오버라이드**하고 `createChartEx`에 넘긴다. 밀도·겹침·티어 선택·8자 제한은
전부 라이브러리가 그대로 처리한다.

### 핵심: 안전한 타임스탬프 접근 (load-bearing — 직접 검증)

오버라이드는 각 포인트의 공개 필드 **`originalTime`**(= 우리가 넘긴 가상 초,
`TimeScalePoint.originalTime`)을 읽어 `axisRef.current.toReal(sec*1000)` + 9h(KST)로 실제
`Date`를 만든 뒤, 인접 KST Date 비교로 weight를 산정해 **`point.timeWeight`**에 대입한다.

두 번들을 직접 비교 검증한 결과:
- 프로덕션 번들의 `fillWeightsForPoints`는 내부 필드를 `t[i].time.Sf`로 읽는다 — 즉
  `_internal_timestamp`가 `.Sf`로 **망글링**된다(prod 번들 `_internal_timestamp` 0회).
- 반면 `originalTime`(prod 12회)·`timeWeight`(prod 11회)·`fillWeightsForPoints`(prod 5회)는
  공개 인터페이스 멤버라 prod 미니파이 번들에서도 **이름이 보존**된다.
- **결론**: 오버라이드는 오직 `point.originalTime`(읽기)·`point.timeWeight`(쓰기)만 사용하고
  내부 필드(`_internal_timestamp`/`.Sf`)는 절대 건드리지 않는다. 이것이 dev/prod 양쪽 안전의 근거.

`maxTickMarkWeight`는 **오버라이드하지 않는다** — 기본 구현의 티어 중재(예: `Hour1<w<Day`→`Hour1`
클램프)를 상속해야 줌 적응이 원래대로 동작한다. 우리는 weight 산정의 *입력 달력*만 가상→실제로
바꾸는 것이지 티어 선택 알고리즘은 손대지 않는다.

### 왜 다른 방법이 아닌가
- **tickMarkFormatter 내부에서 티어 직접 추론**: 라이브러리의 밀도 중재(어떤 눈금을 보일지)를 잃음.
- **실제 타임스탬프를 그대로 피드**: 야간 갭이 시각적으로 되살아남(가상 축 무력화).
- **전면 자작 HTML x축 오버레이**: 밀도·겹침회피 재구현 → 버그 표면 큼.

### 변경 파일

**1. 신규 `frontend/src/util/kstHorzScaleBehavior.ts`**
- `createKstHorzScaleBehavior(axisRef: MutableRefObject<VirtualAxis>)` 팩토리.
- `defaultHorzScaleBehavior()`를 `extends`한 서브클래스 인스턴스 반환.
- `fillWeightsForPoints(points, startIndex)` 오버라이드:
  - `points[i].originalTime`(가상 초) → `axisRef.current.toReal(sec*1000)` → +9h KST `Date`.
  - 인접 KST Date 비교로 weight: 연 다름→70, 월 다름→60, 일 다름→50, else intraday divisor.
  - `axisRef.current.segments.length === 0`이면 `super.fillWeightsForPoints(...)`로 폴백.
  - 첫 포인트(point[0]) weight는 R4 참고 — 가상-공간 평균 추정을 맹목 복제하지 않음.

**2. `frontend/src/live/LiveChartRoot.tsx`**
- `createChart(el, {...})` → `createChartEx(el, createKstHorzScaleBehavior(axisRef), {...})`.
  import `createChart` 제거, `createChartEx` 추가. 반환은 `IChartApiBase<Time>` →
  `setChart(c as IChartApi)` 1회 캐스팅(런타임 객체 동일, `applyOptions` 미사용). 소비처 12곳 무수정.
- `tickMarkFormatter` 단순화: 분봉 "모든 tickType→HH:MM" 우회 제거, tickType 신뢰:
  `Year`→`'${yy}`, `Month`→`${m}월`, `DayOfMonth`→`${d}`, `Time`→`${hh}:${mm}`.
  calendar 분기는 `Time`/`TimeWithSeconds`만 `''`로 억제. KST 변환은 현행 유지.
- `timeFormatter`(크로스헤어 툴팁)는 변경 없음.

**3. `frontend/src/chart/DayBoundaryOverlay.tsx`**
- MM/DD 칩 `<span>` 제거(`fmtMD`·칩 토큰 제거). 세로 점선 `<div>`와 `data-day-boundary` 속성 유지.

### 워크된 예제 (월 경계)

2026-05-29(금) 마지막 캔들 → 2026-06-01(월) 첫 캔들(가상 축 1초 갭 인접):
- KST Date 비교 `getUTCMonth()` 5≠6 → weight 60(Month) → `Month` 티어 → `6월`.
- 일 경계(05-28→05-29): `getUTCDate` 다름 → weight 50 → `DayOfMonth` → `27`. 세로 점선과 위치 일치.
- 줌별: 분 줌은 `6월`+시간 눈금, 중간 줌은 날짜+`6월`, 최대 줌아웃은 `5월`/`6월`/`7월`만.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 월 경계 weight | kstHorzScaleBehavior, 5/29 last + 6/1 first 가상 초 쌍 | `timeWeight === 60` |
| 일 경계 weight | 5/28 last + 5/29 first 쌍 | `timeWeight === 50` |
| 세션 내부 weight | 같은 날 1분 간격 쌍 | intraday weight(예: Minute1=20) |
| tickMarkFormatter Month | 분봉, Month 티어 | `6월` |
| tickMarkFormatter DayOfMonth | 분봉, DayOfMonth 티어 | `27` |
| tickMarkFormatter Time | 분봉, Time 티어 | `09:30` |
| calendar Time 억제 | D, Time 티어 | `''` |
| calendar DayOfMonth | D, DayOfMonth 티어 | `27` |

**Invariant 회귀 테스트**: 기존 [LiveChartRoot.test.tsx:700-768](../../../frontend/src/live/LiveChartRoot.test.tsx)는
구(우회) 동작("세션 중간 DayOfMonth 틱이 14:30")을 인코딩 → **재작성**(위 표). 회귀 테스트는
공개 필드(`originalTime`/`timeWeight`)만 검증하므로 내부 망글링 변화에 영향받지 않는다.
DayBoundaryOverlay 테스트에서 칩 텍스트 단언이 있으면 세로선 단언으로 수정.

### Manual verification

> **번들 주의**: `lightweight-charts` package.json `exports`의 development/production 조건 →
> `vite dev`=언망글 번들, `vite build`=망글 번들. dev 스모크만으로 prod 안전 단정 금지. 공개 필드만
> 쓰는 이유이며 prod 빌드(9)까지 확인한다.

1. **De-risking 스파이크(첫 스텝, R1 포함)**: override에 `(startIndex, points.length, 첫·끝
   originalTime, 산정 weight)` 로그. (a) 호출되는가 (b) lazy-fetch 시 `startIndex` 0/비0
   (c) 앞쪽 틱 weight가 새 축 기준으로 갱신되는가. stale이면 R1 대응. 미호출이면 즉시 중단·재설계.
2. dev 서버 기동(CLAUDE.md "Dev servers").
3. `/browse`로 `/live` 분봉: 기본 줌에 시간+날짜+`N월`, 휠 줌아웃 시 티어 전환, 줌인 시 시간 복귀,
   세로 점선 유지·MM/DD 칩 제거, `console --errors` 무에러.
4. **(필수 게이트, R3)** D/W/M 전환: 날짜/월 라벨 정상, 09:00 미표기, 줌 적응 동작, 전환 반복 시
   1프레임 오정렬(R2) 없음.
5. lazy-fetch 후 날짜/월 라벨 위치 유지.
6. `npm run test` 통과.
7. WebSocket 라이브 틱(ADR-0053 단일 WS) 중 축 라벨 안정.
8. `createChartEx` 전환 후 가격축 폭·바 간격 등 레이아웃 회귀 없음.
9. **프로덕션 빌드**: `npm run build && npm run preview` → preview를 `/browse`로 열어 3~4 반복.
   망글링 안전 최종 입증.

## Risks / Open questions

### R1. lazy-fetch `startIndex` 부분 재계산 → stale weight (최우선)
라이브러리는 증분 삽입 시 `fillWeightsForPoints(points, startIndex>0)`를 부를 수 있다(dev:11760).
이때 앞쪽 캐시된 틱 weight는 재계산되지 않는다. lazy-fetch로 `axisRef.current`가 새 축으로
교체됐는데 tail만 재계산되면 앞쪽 날짜/월 라벨이 옛 축 weight로 고착될 수 있다.
- **대응**: 스파이크(검증 1)로 확인 → stale이면 override에서 `startIndex`를 무시하고 전체(0부터)
  재계산하거나, bundle 변경 시 `series.setData` 전량 리셋이면 startIndex가 항상 0임을 확인.
- "stale 불가능"이라는 단정은 경험 검증 전까지 보류.

### R2. `axisRef.current` 타이밍 (timeframe 전환 1프레임 오정렬)
현 코드는 `axisRef.current = axis`를 **render 중 동기 대입**([LiveChartRoot.tsx:74](../../../frontend/src/live/LiveChartRoot.tsx))
하므로 자식 `RangeSeriesPane`의 data effect `setData`(weight 재계산)는 새 축을 가리킨다(유리).
신규 override가 `axisRef`를 effect로 미루지 않도록 이 순서를 깨지 않는다. 검증 4에 통합.

### R3. calendar(D/W/M) 경로 일관성 (half-fixed 방지)
override는 전 타임프레임 데이터에 적용 → D/W/M 가상-1970 weight 오류도 함께 교정. **기본은
전 타임프레임 공통 적용**(코드 단순·일관)하고 검증 4(D/W/M 라벨·줌 적응)를 **필수 게이트**로 둔다.
(대안: override 내부 `isCalendarTimeframe`면 `super` 위임 — 분봉만 교체.)

### R4. 첫 포인트 휴리스틱 — 가상-공간 math 맹목 복제 금지
라이브러리의 "point[0] weight를 평균 간격으로 추정"은 가상 축의 1초 갭 압축 탓에 평균이 실제-KST
의미를 잃는다. point[0]은 (a) 실제 전일 경계 대비 계산하거나 (b) `super` 동작 수용. 좌측 끝 한
틱이라 영향은 작지만 real-space override에 virtual-space 추정을 섞지 않는다.

## Out of Scope (Backlog)

- 밀도 모드별 캔버스 상수([chartScale.ts](../../../frontend/src/util/chartScale.ts)) 연동.
- 월 라벨 로캘라이즈(영문/축약).
- `^5.2.0` → `5.2.0` 핀 고정(서브클래싱이 동작 형태에 의존) — 구현 시 함께 반영 검토.
