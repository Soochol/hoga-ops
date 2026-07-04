# Live Bundle Split (candle vs hoga) — Design

**Date**: 2026-06-09
**Status**: Phase A·B 구현 완료, Phase C는 coalescing만 구현 (store 리팩터는 의도적 제외) · branch `fix-tf-churn`
**Scope**: `frontend/src/live/useLiveBundle.ts`, `frontend/src/live/buildLiveBundle.ts`, `frontend/src/live/LiveChartRoot.tsx`, `frontend/src/live/LivePage.tsx`, `frontend/src/live/LiveWorkarea.tsx`, `frontend/src/live/LiveStatusBar.tsx`, `frontend/src/chart/RangeSeriesPane.tsx`, `frontend/src/chart/paneSpecs.ts`, `frontend/src/chart/useDrawingHost.ts`

## Problem

/live 페이지가 SSE 'live' 스냅샷 push가 올 때마다 — 장 마감에도 **초당 ~5–9회** — 차트 전체를 재렌더·재setData한다. 사용자 신고: 분봉 전환 시 "캔들이 생긴 뒤 다시 fitting되며 재생성"되는 플리커.

근본 원인(2026-06-09 계측 확정, [[hoga-live-tf-switch-setdata-churn]] 메모리):
- `useLiveBundle.computedBundle`이 `live.ob`/`live.trade`에 의존한다. SSE push마다 `LiveSnapshotBuffer.get()`이 새 frozen 배열 ref를 반환 → `computedBundle` 재실행 → **새 `bundle` 객체**.
- `bundle`은 candle 데이터(ob/trade 무관)와 hoga 지표(quote_ratio/fill_strength, ob/trade 의존)를 **한 객체**에 묶고 있다. 그래서 ob/trade만 바뀌어도 candle 경로(candle·volume 패널, axis, MA/툴팁/현재가선)까지 새 bundle을 받아 재렌더·재setData한다.
- lightweight-charts는 setData마다 price-scale autoscale + viewport 재정착을 돌리므로, 차트가 막 remount된 전환 직후엔 이 재push가 화면을 흔든다(플리커). idle엔 lwc가 정착된 우측끝 viewport를 보존해 비가시였다.

이미 머지된 `RangeSeriesPane` setData-signature-skip fix(0348a99)는 candle의 **가시 증상**을 막지만, **재렌더 자체와 bundle churn은 그대로**다. 이 spec은 churn을 구조적으로 제거한다.

## Invariants

- **Single axis build / segments identity**: `LiveChartRoot`의 axis는 `bundle.segments` **참조**에 메모이즈된다. SSE push가 segments 내용을 안 바꾸면 같은 ref가 재사용되어 axis가 재빌드되지 않는다(가중치/라벨 캐시 churn 방지). 근거: [LiveChartRoot.tsx](../../../frontend/src/live/LiveChartRoot.tsx) `useMemo([bundle?.segments])`, [useLiveBundle.ts](../../../frontend/src/live/useLiveBundle.ts) segments-identity 안정화 블록, [[hoga-ops-virtual-axis-collision]].
- **Candle source independence (ADR-0040)**: 캔들은 `/api/live/past-candles`(KIS) 단일 소스이며 hoga(`/api/range`) 커버리지·SSE ob/trade와 **무관**하다. 근거: [buildLiveBundle.ts](../../../frontend/src/live/buildLiveBundle.ts) `candles: kisCandles`, `pastBundle.candles` 무시 주석.
- **Hoga seam (ADR-0049)**: 오늘 hoga 지표 = `[past (t ≤ pastMaxQrT)] + [SSE incremental (t > pastMaxQrT)]`로 봉합되며, today-segment는 today-signal(past 오늘점 / SSE ob / kis 오늘캔들 중 하나)이 있을 때만 추가된다. 근거: buildLiveBundle.ts:86–106.
- **Drawing pane binding stable id (ADR-0028)**: 각 `PaneSpec.name`은 사용자 Drawing의 pane 바인딩 영속 키다(rename 금지, reorder 무방). 근거: [paneSpecs.ts](../../../frontend/src/chart/paneSpecs.ts) `BoundPaneSpec`.
- **Viewport ownership (initial-view ↔ backfill 상호배타)**: 좌측 팬 백필은 candles/segments 변경으로 표현되고 `historicalFromDate≠null`로 게이트된다. 근거: [useViewportBackfill.ts](../../../frontend/src/live/useViewportBackfill.ts), LiveChartRoot initial-view effect.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Single axis build / segments identity | **preserves** | chartBundle과 hogaBundle이 **같은 segments ref를 공유**(hogaBundle = `{...chartBundle, quote_ratio, fill_strength}`). axis는 chartBundle.segments로만 빌드. |
| Candle source independence | **preserves (강화)** | candles를 chartBundle에 두고 hoga 슬라이스에서 완전 분리 — ob/trade가 candle 경로를 건드릴 구조적 경로 자체가 사라짐. |
| Hoga seam | preserves | `buildHogaSeries`가 기존 incremental-filter·today-signal 로직을 그대로 가져감. today-signal은 boolean으로 강등되나 판정 결과 동일. |
| Drawing pane binding stable id | preserves | `PaneSpec`에 추가하는 `live?: boolean`은 가산적 옵션 필드. `name` 불변. |
| Viewport ownership | preserves | 백필 = candles/segments 변경 → chartBundle 갱신 → 정상 흐름. hogaBundle은 spread로 따라옴. |

*intentionally breaks: 없음.*

### 2026-07-05 Amendment — Hogaplay Candle Fallback

The original "KIS single candle source" wording is no longer absolute. Normal
KIS candle flow still uses **Live Candle Backfill** and **KIS Candle Cache** per
ADR-0040/0048, but `/live` may use **Hogaplay Candle Fallback** from
`/api/range` when KIS REST is bypassed, unavailable, or the user prefers
hogaplay candles. The bundle split invariant remains: candle data is still kept
on the chart side and must not depend on SSE `ob`/`trade` array references.

## Goals

- ob/trade SSE push만 발생할 때 **candle/volume 패널·axis·candle 오버레이가 재setData·재렌더되지 않는다**(측정: 틱당 candle `setData` = 0, candle 패널 self-render = 0).
- hoga 패널(ratio/quoteTotals/fillStrength)은 push에 정상 갱신(정당한 live 업데이트).
- 타입(`RangeBundle`)과 projector 시그니처 무변경 — 변경 표면을 데이터 오케스트레이션 + 라우팅 + 메모로 한정.
- 분봉 전환 플리커가 setData-skip fix 없이도 구조적으로 사라짐(skip fix는 안전망으로 잔존).

## Non-Goals

- **사이드바(OrderbookTable 등)·관심종목 Row의 틱 재렌더**: `LiveSidebar`는 `live.ob`/`broker`를 직접 소비하는 별도 경로다. 같은 원리(store/coalesce)로 해결 가능하나 이 spec 범위 밖(§Out of Scope).
- **SSE 업데이트 coalescing(throttle)**: 직교하는 보완책(①). 본 spec은 "분리"가 우선. Phase C에서 결합 가능.
- D/W/M(calendar) 경로: hoga 패널이 없어(ADR-0041) 이미 ob/trade churn 영향 적음 — 분리로 자동 수혜, 별도 작업 불요.

## Design

### 데이터: `useLiveBundle`가 두 객체 반환

```ts
export interface UseLiveBundleResult {
  chartBundle: RangeBundle | null;   // ob/trade 무관, push에 안정
  hogaBundle: RangeBundle | null;    // {...chartBundle, quote_ratio, fill_strength}, push마다 갱신
  isLoading; error; clampEngaged; isPastCandlesLoading; isExtending;
}
```

`buildLiveBundle`을 둘로 분할:
- **`buildChartBundle(...)`** → `{ code, from_date, to_date, bucket_ms, segments, candles, investorPoints, volume_profile_* , quote_ratio: EMPTY, fill_strength: EMPTY }`. 입력: pastBundle(segments용), kisCandles, todaySession, **`hasTodayObSignal: boolean`**, bucketMs, investorPoints. segments 합성 + 안정화(prevSegmentsRef)는 여기로 이동.
- **`buildHogaSeries(...)`** → `{ quote_ratio, fill_strength }`. 입력: pastBundle, sseOb, sseTrade, bucketMs, todaySession. 기존 incremental QR/FS 필터(`t > pastMaxQrT`) 로직 그대로.

```ts
const hasTodayObSignal = live.ob.length > 0;  // boolean (ref 아님) — 첫 틱 후 안정
const chartBundle = useMemo(() => code ? buildChartBundle({
  code, todayDate: today, todaySession, pastBundle: past.data ?? null,
  kisCandles, bucketMs, investorPoints, hasTodayObSignal,
}) : null, [code, today, kisCandles, bucketMs, past.data, investorPoints, hasTodayObSignal /*, todaySession 파생값*/]);

const hogaSeries = useMemo(() => buildHogaSeries({
  pastBundle: past.data ?? null, sseOb: isMinute ? live.ob : [], sseTrade: isMinute ? live.trade : [],
  bucketMs, todaySession,
}), [past.data, live.ob, live.trade, bucketMs /*, todaySession 파생값*/]);

const hogaBundle = useMemo(() => chartBundle
  ? { ...chartBundle, quote_ratio: hogaSeries.quote_ratio, fill_strength: hogaSeries.fill_strength }
  : null, [chartBundle, hogaSeries]);
```

핵심: `chartBundle` 메모 deps에 **`live.ob`/`live.trade` 배열 ref가 없다**(boolean만). `past.data`(hoga refetch 5분)·kisCandles(타임프레임/백필)만 candle 경로를 바꾼다.

> **isExtending 원자화**: 현 `extending` 게이트는 그대로 chartBundle 산출에 적용(`bundle = extending ? lastSettled : computed`를 chartBundle에 적용). hogaBundle은 chartBundle 위에 spread하므로 동반 안정.

### 라우팅: 패널별로 알맞은 bundle 주입

`PaneSpec`에 가산 필드:
```ts
export type PaneSpec<Ctx = void> = { name; stretch; series; useContext?; live?: boolean };
```
`paneSpecs.ts`에서 hoga 3종만 태깅: `QUOTE_TOTALS_SPEC`, `RATIO_SPEC`, `FILL_STRENGTH_SPEC` → `live: true`. (candle/volume/investor는 미설정 = chart.)

`LiveChartRoot` 매핑:
```tsx
{specs.map((spec, i) => (
  <RangeSeriesPane
    bundle={spec.live ? hogaBundle! : chartBundle!}
    axis={axis} spec={spec} paneIndex={i}
    onPrimarySeriesReady={onReady} onPrimarySeriesGone={onGone} />
))}
```
- axis는 `chartBundle.segments`로 빌드(현행과 동일, `bundle`→`chartBundle`).
- 나머지 candle-path 소비자 전부 `chartBundle`: `MovingAverageOverlay`, `CandleTooltip`, `LiveCurrentPriceLine`, `DayBoundaryOverlay`, `AuctionWindowOverlay`, `useWheelInteractions`, `useViewportBackfill`, 그리고 `LiveStatusBar`(candles+segments).
- hoga projector(fillStrength)가 읽는 `segments`/`bucket_ms`는 hogaBundle이 spread로 보유.

### 재렌더 격리 (분리만으론 LiveChartRoot가 hogaBundle prop으로 여전히 재렌더)

- `RangeSeriesPane`을 `React.memo`로 감싼다. candle/volume 패널은 `bundle=chartBundle`(안정)+`axis`(안정)+안정 콜백 → LiveChartRoot 재렌더 시 **skip**. hoga 패널은 `hogaBundle`(갱신) → 재렌더(정당).
- memo 성립 조건: `onPrimarySeriesReady`/`onPrimarySeriesGone`를 `useDrawingHost`에서 `useCallback`으로 고정(현 인라인 화살표 → 매 렌더 새 함수라 memo 무효). `spec`은 모듈 상수(안정).
- candle-path 오버레이(MovingAverage/CandleTooltip/CurrentPriceLine/DayBoundary/AuctionWindow)도 `React.memo` + 안정 props.

### setData-skip fix와의 관계

분리 후 candle 패널은 stable chartBundle을 받아 data effect deps가 안 변함 → setData 미호출. 머지된 signature-skip fix는 **cold-load·잔여 churn 안전망**으로 격하(유지).

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| chartBundle 안정 | useLiveBundle를 렌더, `live.ob`/`live.trade`만 새 ref로 교체 | `chartBundle` ref **불변**, `hogaBundle` ref **변경** |
| segments 공유 | 동상 | `chartBundle.segments === hogaBundle.segments` |
| candle 무관성 | ob/trade 변경 | `chartBundle.candles` ref 불변(=kisCandles) |
| hoga 봉합 보존 | past + SSE incremental | `hogaBundle.quote_ratio.points`가 기존 buildLiveBundle와 동일(스냅샷 비교) |
| today-signal boolean | sseOb 0→N | today-segment 추가 시점이 기존과 동일 |
| RangeSeriesPane memo | 같은 bundle/axis/콜백으로 rerender | candle 패널 `setData` 재호출 없음(현 RangeSeriesPane.test 확장) |

**Invariant 회귀**: "Single axis build" → ob/trade 변경 후 `axis` ref 불변 어서션. "Candle source independence" → 위 candle 무관성 케이스.

### Manual verification (브라우저, 워크트리 vite :5174 + `/api` proxy 재사용)

- 5m 정착 상태에서 idle 3s: `__depLog`에서 `chartBundle` 변경 0, candle 패널 self-render 0(PerformedWork walk), hoga 패널만 재렌더.
- 1m→5m 전환: candle `setData` ≤1, 재fit 플리커 없음(스크린샷 시퀀스).
- chart/live 테스트 스위트(현 548개) 그린 유지.

## Risks / Open questions

- **콜백 안정화 누락 시 memo 무효**: useDrawingHost의 register/unregister가 useCallback이어야 함 → 테스트로 가드(candle 패널 re-setData 0).
- **todaySession 파생 deps**: `live.initial` 변경(세션 메타) 시 chartBundle 갱신 필요 — deps에 세션 open/close ms(원시값) 포함해 정확히.
- **hogaBundle spread 비용**: 틱마다 얕은 객체 생성(저렴). 단 spread가 candle 패널로 새 ref를 흘리지 않도록 candle 패널은 반드시 `chartBundle`을 받아야 함(라우팅 정확성).
- **LiveChartRoot 자체 재렌더 잔존(Phase A/B)**: hogaBundle prop으로 LiveChartRoot는 틱마다 렌더(맵핑+axis useMemo 안정이라 저렴, 패널/오버레이는 memo로 skip). 완전 제거는 Phase C(store).

## Phase C — coalescing 구현 / store 의도적 제외 (2026-06-09)

**구현됨: tick coalescing.** `useLiveSeries`의 WS push flush를 trailing-throttle
(`LIVE_FLUSH_MS=150`)로 묶음 — push마다 /live 소비 트리 전체(LivePage → hoga 패널 +
사이드바 + 관심종목)가 재렌더되므로, push 빈도(장중 수십~수백/s)와 무관하게 재렌더를
≤~6.7Hz로 바운드. 버퍼는 모든 push를 누적(재-READ만 throttle → 유실 없음). 트레이드오프:
라이브 hoga·사이드바 표시에 ≤150ms 지연(현재가선은 useQuotes 경로라 무관). 검증: 커밋률
~5.2Hz(avgGap 203ms), 5패널 정상.

**제외됨: store 리팩터.** 분석 결과 risky/marginal로 판단(stronger-reviewer 합의 + 사용자
결정 2026-06-09):
- 앱 전역 재렌더의 지배 요인은 **틱 빈도**이지 wrapper가 아니다. live-data를 *표시*하는
  컴포넌트(hoga 패널·OrderbookTable·관심종목 Row)는 store를 써도 틱마다 재렌더된다(새
  데이터를 그려야 하므로). store가 제거하는 건 LivePage/LiveChartRoot/LiveStatusBar 같은
  wrapper 재렌더뿐인데, **Phase B 이후 자식이 전부 memo라 이 wrapper 재렌더는 이미 싸다**
  (함수 본문 + bail되는 reconciliation).
- 따라서 큰 이득은 coalescing(위)에 있고, store는 고위험(단일 WS 불변식, 차트↔사이드바
  동기화)·저한계이득. coalescing이 같은 목표(앱 전역 재렌더 절감)를 더 안전하게 달성.

## Out of Scope (Backlog)

- **store 리팩터 (재고 시)**: ob/trade를 zustand store로 빼 wrapper(LivePage/LiveChartRoot/
  StatusBar) 재렌더까지 제거. 위 분석대로 한계이득이라 보류. 진행 시 단일 WS 불변식 + 차트↔
  사이드바 동기화가 핵심 리스크.
- 사이드바/관심종목 틱 재렌더 격리(같은 store 기반).
