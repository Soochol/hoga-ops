# FillStrength 누적 델타 라인 — Design

## 목적

체결강도 (FillStrength) pane에 **당일 누적 매수−매도** 라인을 추가해, 매수/매도 막대 두 시리즈만으로는 즉시 보이지 않는 *세션 내 누적 압력의 방향과 기울기*를 한눈에 볼 수 있게 한다.

## 도메인 / 용어

- **체결강도 / FillStrength**: `bundle.fill_strength.points[]`에 담긴 버킷별 `{ t, buy_qty, sell_qty }` 시계열 (CONTEXT.md "FillStrength" 참고).
- **당일 누적 매수−매도 (Cumulative Net Fill)**: 거래일 세션 시작부터 매 버킷까지의 `sum(buy_qty − sell_qty)`. 거래일 경계에서 0으로 리셋. 키움/이베스트 HTS의 "체결강도 추이" 와 같은 결의 지표.

## 결정 사항 (Brainstorming 합의)

| # | 결정 | 근거 |
|---|---|---|
| Q1 | 값은 **당일 누적**(per-day running sum of `buy − sell`), per-bucket net 아님 | "당일 날 흐름"이라는 사용자 의도. 누적은 한 방향 추세선이라 압력 우위 전환점이 명확히 읽힘 |
| Q2 | 같은 pane 안에서 **invisible overlay scale** (`priceScaleId: ''`) | 누적값 magnitude가 막대보다 1-2 자릿수 크므로 공유 axis면 막대가 baseline에 깔림. 좌/우 분리 축은 다른 pane 정렬을 깨고 절대값 라벨은 cross­hair로 충분 |
| Q3 | 기본 ON + Settings 토글 가능 (per-tab pref) | 사용자가 직접 요청한 지표라 노출 기본값 ON. 시각적으로 무겁다 느낄 경우 끌 길은 열어둠. 기존 `auctionWindowMask` / `outlierFilter` 패턴과 일관 |
| Color | Neutral `--fg` 단색 (sign-aware 아님) | 막대(매수=빨강 / 매도=파랑)와 색 겹치지 않아 "derived" 신호 자연스러움. DESIGN.md 토큰 추가 없음 |

## 아키텍처

### 데이터 흐름

```
RangeBundle (fill_strength.points[], segments[])
        │
        ▼
projectCumulativeDelta(bundle, axis, ctx)
   - segments[]를 시간순 순회
   - 각 segment 시작에서 runningSum = 0
   - 모든 in-segment 포인트에 대해 runningSum += (buy_qty - sell_qty)
   - axis.contains(t) 인 포인트만 emit { time, value: runningSum }
        │
        ▼
LineSeries (priceScaleId: '', lineWidth: 2, color: --fg)
        │
        ▼
체결강도 pane (히스토그램 2개 위에 오버레이)
```

핵심 invariant: `axis.contains` false 인 점도 **누적합에는 포함**, **emit만 제외**. 그렇지 않으면 viewport 좌측에서 라인이 0이 아닌 baseline에서 시작해 잘못된 추세를 그린다.

### 파일별 변경

| 파일 | 변경 |
|---|---|
| `frontend/src/chart/projectors/fillStrength.ts` | `projectCumulativeDelta` 함수, `FillStrengthPaneContext` 타입, `useFillStrengthContext` 훅, `FILL_STRENGTH_SPEC.series[]`에 3번째 LineSeries 추가 |
| `frontend/src/state/chartPrefs.ts` | `ChartViewPrefs`에 `fillStrengthCumulative: boolean`, `DEFAULT_PREFS`에 `true` 기본값 |
| `frontend/src/state/tabs.ts` | `setFillStrengthCumulative(tabId, value)` setter export |
| `frontend/src/state/tabsPersistence.ts` | `mergePrefs`의 known-key 목록과 validation에 신규 필드 포함 |
| `frontend/src/replay/settings/IndicatorsSection.tsx` | "보조지표 → Moving Average" 그룹 다음에 "FILL STRENGTH" 서브헤더 + 토글 row 1개 |
| `CONTEXT.md` | FillStrength 항목 끝에 누적 라인 1-2줄 추가 |

### Pane 컨텍스트 / 토글 동작

- `FillStrengthPaneContext = { cumulativeEnabled: boolean }`.
- `useFillStrengthContext()`는 `useActivePrefs`를 통해 `fillStrengthCumulative`만 selecting (`useShallow` 불필요, primitive boolean).
- 토글 OFF 시 `projectCumulativeDelta`가 `[]` 반환 → 라인은 사라지지만 series 핸들은 유지. `RangeSeriesPane`의 lifecycle/data effect 분리 invariant ([RangeSeriesPane.tsx:75-79](../../frontend/src/chart/RangeSeriesPane.tsx#L75-L79)) 그대로 따른다. 토글로 series churn 발생 안 함.

### 라인 스타일

기존 [fillStrength.ts](../../frontend/src/chart/projectors/fillStrength.ts)의 `TOKEN_SPEC`에 색 토큰 추가하고 모듈 로드 시점에 hex로 resolve:

```ts
const TOKEN_SPEC = {
  buy: ['--price-up', '#DC2626'],
  sell: ['--price-down', '#2563EB'],
  cumulative: ['--fg', '#E5E7EB'],        // 신규
  cumulativeBaseline: ['--fg-dimmer', '#64748B'],  // 신규 (0-baseline 가이드선)
} as const;
const { buy, sell, cumulative, cumulativeBaseline } = resolveTokens(TOKEN_SPEC);
```

(lightweight-charts options는 hex 문자열을 요구하므로 `var(--fg)` 직접 전달 불가. 기존 `resolveTokens` 헬퍼가 fallback 포함 hex로 변환.)

```ts
{
  type: LineSeries,
  options: {
    color: cumulative,
    lineWidth: 2,                 // MA(1) < cumDelta(2) < Ratio(3) 시각 우선순위
    lineStyle: 0,                 // 실선 (사용자 명시 요청)
    priceScaleId: '',             // invisible overlay scale — autoscale 분리
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: {
      type: 'custom',
      formatter: (v) => v.toLocaleString('ko-KR'),  // 음수는 '-' 접두 자동
      minMove: 1,
    },
  },
  data: projectCumulativeDelta,
  afterAdd: (series) => {
    series.createPriceLine({
      price: 0,
      color: cumulativeBaseline,
      lineWidth: 1,
      lineStyle: 1,               // dotted
      axisLabelVisible: false,
      title: '',
    });
  },
}
```

0-baseline 가이드선은 라인이 0을 가로지르는 순간이 매수/매도 누적 우위 전환점이므로 시각 reference로 둔다.

### Settings UI

`IndicatorsSection.tsx`의 "보조지표" 헤더 아래, Moving Average 그룹 다음:

```
보조지표
─────────────────
MOVING AVERAGE
  [●━━] MA 5    [5]   ●
  ... (기존 5행)

FILL STRENGTH
  [●━━] 당일 누적 매수−매도
```

- 서브헤더 스타일: 기존 `text-fg-dim text-[11px] uppercase tracking-wider mb-2` 재사용.
- 토글 row grid: `grid-cols-[36px_1fr]` (period input/color dot 없으니 MA row 대비 단순).
- 토글 스위치: MA row의 패턴 그대로 (`bg-accent` ↔ `bg-bg-input-hover`).
- `data-testid="fill-strength-cumulative-toggle"`.

## 엣지 케이스 / Invariant

| 케이스 | 처리 |
|---|---|
| 빈 `fill_strength.points` | projector가 `[]` 반환 |
| Range가 다일(多日) | `bundle.segments[]` 각 segment 시작마다 runningSum = 0 — 매일 0에서 출발하는 톱니파 |
| Range가 거래일 중간에 시작 (axis 좌측이 세션 중간) | 누적합은 항상 `session_open_ms`부터 계산. axis 밖 포인트도 합산하되 emit만 안 함 |
| 장 마감 동시호가 (15:20–15:30) | 마스킹 없음. 체결이 없으니 라인은 마지막 값으로 평탄, 15:30 cross 단일 체결에서 한 번 점프 |
| Chart teardown race | `RangeSeriesPane`의 `try { removeSeries } catch` 그대로 적용 — 신규 코드 불필요 |
| Pref 누락 (구버전 localStorage) | `tabsPersistence.mergePrefs`가 default `true`로 채움 |

## 테스트

### Projector 단위 테스트 (`fillStrength.test.ts` 확장)

- 단일 거래일 monotonic 입력 → 누적이 식대로 증가.
- 매수만 / 매도만 / 0 버킷 혼합 → 양/음/평탄 검증.
- 다일 range (2 segments) → 둘째 날 첫 점이 0에서 재시작.
- Axis 밖 포인트가 누적합에는 포함되지만 emit은 제외 — viewport 좌측 잘림 invariant.
- 빈 `points` → `[]` 반환.
- 15:30 cross 포인트에서 누적값 점프 (마스킹 없음 검증).

### Persistence 테스트 (`tabsPersistence.test.ts` 확장)

- `fillStrengthCumulative` 누락 → 기본값 `true`.
- 잘못된 타입(문자열) → 기본값으로 폴백.
- `true` / `false` 명시 → 보존.

### Component 테스트 (`ChartStage.test.tsx` 패턴)

- 토글 ON → pane의 `addSeries` 호출 **3회** (buy histogram + sell histogram + cumulative line).
- 토글 OFF → 라인 series는 존재하지만 마지막 `setData` 호출이 `[]`.

### Settings UI 테스트 (`IndicatorsSection.test.tsx` 확장)

- 토글 클릭 → `setFillStrengthCumulative(activeTabId, !current)` 호출.
- `aria-checked` 가 prefs 값과 일치.

## 범위 밖 (안 하는 것)

- 누적 라인 자체의 MA / 스무딩.
- 매수-only / 매도-only 누적 라인 분리.
- 누적량 절대값을 우측 axis label로 노출 (Q2-B 결정에 따라 invisible scale 유지).
- 매수/매도 히스토그램 막대 자체의 on/off 토글 (사용자 요청 범위 밖).
- 색·선두께·0-baseline on/off sub-control (YAGNI; 필요 생기면 그때 expand).
- 백엔드 변경. 모든 계산은 프론트엔드 projector에서.

## 참고

- 기존 패턴: [quoteTotals.ts](../../frontend/src/chart/projectors/quoteTotals.ts) (라인 2개 + invisible 단일 pane), [ratio.ts](../../frontend/src/chart/projectors/ratio.ts) (Baseline + `afterAdd` priceLine).
- Pane lifecycle 계약: [RangeSeriesPane.tsx](../../frontend/src/chart/RangeSeriesPane.tsx), 디자인 doc `2026-05-23-range-series-pane-design.md`.
- RangeBundle wire model: ADR-0013, CONTEXT.md "RangeBundle" 항목.
