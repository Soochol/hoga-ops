# /live 캔들 — 가시범위 최고가/최저가 극값 대비율 라벨 — Design

**Date**: 2026-06-12
**Status**: Grilled (2026-06-12 — `/grill-with-docs`; CONTEXT.md 용어 등재 완료)
**Scope**: `frontend/src/live/visibleExtremes.ts`(신규 순수 — 가시 캔들 극값), `frontend/src/live/formatExtremeLabel.ts`(신규 순수 — 라벨 문자열), `frontend/src/live/HighLowAnnotationOverlay.tsx`(신규 오버레이), `frontend/src/state/chartPrefs.ts`(`highLowLabelsEnabled` 토글 1줄), `frontend/src/live/LiveChartRoot.tsx`(오버레이 마운트 1줄)

> **용어(그릴링 확정)**: 이 지표 = **극값 대비율 (Extreme Gap)** = `(현재가 − 가시 극값)/극값 × 100`.
> 글로서리 **등락률**(vs 전일종가)·**봉대비**(vs 직전봉)와 **구별되는 제3의 기준**(vs 가시 극값). CONTEXT.md
> `극값 대비율` / `High/Low Extreme Labels` 등재 + Flagged ambiguities 기록(2026-06-12). 아래 본문의 "등락률"
> 표현은 모두 이 **극값 대비율**을 가리킨다.

## Problem

사용자 표현:

> "live 차트에서 기능추가. 현재 보이는 화면 캔들 차트 영역을 기준으로, 현재가 대비, 최솟값, 최댓값 등락률
> 표시, 최소 최대 캔들에 만들어줘"

레퍼런스 이미지 2장: 라벨 `38,800원 (-4.38%, 06.12 09:51)`(고가, 빨강) / `36,750원 (+0.95%, 06.12 14:51)`(저가, 파랑).

/live 캔들 차트에서 **현재 보이는 뷰포트 범위의 최고가 봉·최저가 봉**에, **현재가 대비 등락률**과
가격·시각을 담은 라벨 + 작은 마커 점을 표시한다. 팬/줌으로 보이는 범위가 바뀌면 극값·라벨도 따라 갱신된다.
설정창에서 on/off 토글로 끌 수 있다(기본 켬).

> 참고: 동일 개발자의 별도 프로젝트 `dev-tradingview`에 같은 기능이 `HighLowAnnotationPrimitive`(일봉 전용)로
> 존재한다 — 알고리즘·색·라벨 포맷의 검증된 레퍼런스이나, hoga-ops는 차트 아키텍처(VirtualAxis + React
> 오버레이)가 달라 이식이 아니라 이 아키텍처에 맞춘 재구현이다.

## Invariants

- **캔들 단일 출처 + VirtualAxis 투영**: /live 캔들 패널은 `RangeBundle.candles`(`Candle = { ts_ms, open,
  high, low, close, vol_a, vol_b }`)를 `projectCandle`로 그리며, 각 봉의 x좌표는 `axis.toVirtual(ts_ms)/1000`
  (가상초), 그려지는 봉은 `axis.contains(ts_ms)`로 거른다. 근거: [projectCandle](../../../frontend/src/chart/projectors/candle.ts), [api/types.ts:29](../../../frontend/src/api/types.ts), [CandleTooltip](../../../frontend/src/live/CandleTooltip.tsx#L88).
- **현재가 단일 산출**: /live의 "현재가"는 **마지막 캔들 종가**(`candles.at(-1).close`)다 — 현재가 라인·
  StatusBar와 동일. quote는 색(전일대비)만 결정. 근거: [deriveCurrentPriceLine.ts](../../../frontend/src/live/deriveCurrentPriceLine.ts).
- **KST 시각 변환 단일 규칙**: ts_ms(실 Unix ms) → KST 라벨은 `new Date(ts_ms + 9h)` 후 `getUTC*` —
  "LiveChartRoot timeFormatter와 동일 규칙"(분봉=`MM.DD`/`HH:MM`, 캘린더=날짜만). 근거: [candleTooltipModel.ts:26](../../../frontend/src/live/candleTooltipModel.ts).
- **visible range 반응 패턴**: 보이는 범위에 반응하는 오버레이는 `chart.timeScale()`의
  `subscribeVisibleLogicalRangeChange`를 rAF throttle로 구독하고 차트 API를 read-only로 읽는다.
  근거: [PaneLegendOverlay.tsx:251](../../../frontend/src/live/PaneLegendOverlay.tsx).
- **설정 레지스트리 = 단일 진실원**: boolean 토글은 `CHART_TOGGLES` 엔트리 1개로 끝 — `ChartViewPrefs`
  타입·`DEFAULT_PREFS`·설정 UI 렌더가 전부 파생. 읽기는 `useActivePrefs(p => p.<key>)`.
  근거: [chartPrefs.ts](../../../frontend/src/state/chartPrefs.ts), 선례 `candleTooltipEnabled`/`surgeMarkerEnabled`.
- **색 규약(KRX, DESIGN.md 성역)**: 상승=빨강(`--price-up`), 하락=파랑(`--price-down`). 데이터 시각화에
  브랜드 violet 금지. 근거: DESIGN.md, [candle.ts:11](../../../frontend/src/chart/projectors/candle.ts).
- **/live bundle-split**: 캔들 경로 오버레이는 안정 `chartBundle`(cb)을 받아 SSE 호가 틱에 재렌더되지
  않는다(memo). 근거: [LiveChartRoot.tsx](../../../frontend/src/live/LiveChartRoot.tsx) `cb`, PaneLegendOverlay memo.
- **캔들은 Auction Mask 비참여**: 캔들 pane은 마감 동시호가(15:20–15:30) 봉도 muted 색으로 **항상 그린다**
  (`auctionWindowMask` 토글 무관) — ADR-0018/0029 carve-out. 따라서 극값 라벨도 캔들과 동일하게 동시호가
  봉을 극값 후보에 **포함**한다(그릴링 Q2 확정). 근거: [projectCandle](../../../frontend/src/chart/projectors/candle.ts) muted 분기, CONTEXT.md `Auction Mask`.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 캔들 단일 출처 + VirtualAxis 투영 | preserves | 극값은 패널이 그리는 *바로 그* `candles`(axis.contains 필터)에서 계산 → 마커가 캔들과 정렬 |
| 현재가 단일 산출 | preserves | 등락률 기준 현재가 = `candles.at(-1).close`(현재가 라인과 동일 출처) |
| KST 시각 변환 단일 규칙 | preserves | `formatExtremeLabel`이 `candleTooltipModel.kstLabels`와 동일 +9h/getUTC 규칙 사용 → 9h 어긋남 없음 |
| visible range 반응 패턴 | preserves | PaneLegendOverlay와 동일 rAF-throttle 구독, 차트 read-only |
| 설정 레지스트리 단일 진실원 | preserves | `CHART_TOGGLES` 1줄 추가, 새 스토어 필드·UI 컴포넌트 없음 |
| 색 규약(KRX) | preserves | 고가=`--price-up`, 저가=`--price-down`, 토큰만 사용 |
| /live bundle-split | preserves | 오버레이는 cb(안정)만 읽고 memo → SSE 틱 재렌더 없음. 갱신은 cb 변경 + visible range 변경에서만 |
| 캔들 Auction Mask 비참여 | preserves | 극값 후보 = 그려진 모든 캔들(동시호가 포함) → 캔들 pane과 동일 기준, 화면 최고/최저봉에 라벨 |

## Goals

- 보이는 뷰포트 범위의 **최고가 봉(최댓값)·최저가 봉(최솟값)** 각각에 작은 점 마커 + 라벨.
- 라벨 = `"<가격>원 (<±등락률>%, <MM.DD HH:MM>)"`. 등락률 = `(현재가 − 극값) / 극값 × 100`.
  - 고가 라벨: 현재가 ≤ 고가 → 보통 음수%(예 `-4.38%`), 빨강.
  - 저가 라벨: 현재가 ≥ 저가 → 보통 양수%(예 `+0.95%`), 파랑.
- **팬/줌 시 자동 갱신** — 보이는 범위가 바뀌면 극값·라벨 재계산(visible range 구독).
- **종목·타임프레임 전환 시 갱신** — cb(chartBundle) 변경에 반응.
- 분봉=`MM.DD HH:MM`, D/W/M=`MM.DD`(시각 생략, 캘린더 봉은 09:00 앵커라 시각 무의미).
- **설정 토글**(`highLowLabelsEnabled`, 기본 ON) — 설정창 "차트" 카테고리에 자동 노출.
- 극값 탐색·라벨 포맷은 **순수 함수 + 단위 테스트**.

## Non-Goals

- 별도 실시간 quote를 현재가로 쓰기 — 마지막 캔들 종가로 충분(현재가 라인과 동일 컨벤션 유지).
- 라벨 충돌 회피(고가·저가가 화면에서 가까울 때 겹침) 정교화 — v1은 단순 오프셋. 평가 후 조정.
- 극값 외 통계(평균·거래량 가중 등), 다구간 비교, 알림.
- dev-tradingview `HighLowAnnotationPrimitive` 직접 이식(아키텍처 상이).

## Design

### 1) 가시 극값 탐색 (순수) — `visibleExtremes.ts`

```
type Extreme = { price: number; pct: number; tsMs: number; virtualSec: number };
type VisibleExtremes = { high: Extreme; low: Extreme } | null;

computeVisibleExtremes(
  candles: readonly Candle[],
  axis: VirtualAxis,
  visibleRange: { from: number; to: number } | null,   // 가상초 (chart Time)
  currentPrice: number | null,
): VisibleExtremes
```

- `visibleRange === null`(초기 mount) 또는 `candles.length === 0` 또는 `currentPrice == null` → `null`(no-op).
- 각 봉에 대해: `axis.contains(ts_ms)` 가 false면 skip(그려지지 않는 봉). `vSec = axis.toVirtual(ts_ms)/1000`.
  `vSec < from || vSec > to` 면 skip(범위 밖). 남은 "보이는 봉" 중 `high` 최대, `low` 최소를 추적
  (동률은 첫 발생 유지 — 스크롤 중 흔들림 방지).
- `pct = (currentPrice − price) / price × 100` (= **극값 대비율**).
- 보이는 봉이 0개면 `null`.
- **동시호가 포함(그릴링 Q2)**: `axis.contains` 필터만 적용 — 마감 동시호가 봉도 그려지므로 극값 후보에
  포함(별도 동시호가 제외 없음, surge와 상반). 캔들 pane과 동일 기준.
- **거래일별 리셋 없음**: bundle.candles가 멀티데이 concat이어도 "현재 보이는 범위의 **전역** 극값"이 목표라
  surge처럼 거래일 경계 리셋을 하지 않는다(visible range 필터가 곧 범위 제한). 여러 날이 보이면 그 전체의
  최고/최저.
- **lightweight-charts 비의존** — 좌표→픽셀 변환은 호출부(오버레이)가 담당. 단위 테스트 대상.

> `visibleRange` 출처: 오버레이가 `chart.timeScale().getVisibleRange()`(가상초 `{from,to}`, 데이터로
> 클램프)를 넘긴다. 논리범위(`getVisibleLogicalRange`, 인덱스) 대신 시간범위를 쓰는 이유: 시간범위는
> 데이터에 클램프돼 "실제 보이는 봉"과 일치하고, ts_ms 기반 극값 탐색과 자연스럽게 맞물린다.

### 2) 라벨 포맷 (순수) — `formatExtremeLabel.ts`

```
formatExtremeLabel(price: number, pct: number, tsMs: number, timeframe: LiveTimeframe): string
//  → "38,800원 (-4.38%, 06.12 09:51)"   (분봉)
//  → "38,800원 (-4.38%, 06.12)"          (D/W/M)
```

- 가격 = `Math.round(price).toLocaleString('ko-KR')` + `'원'` (candle.ts `priceFormat`과 동일).
- 부호 = `pct >= 0 ? '+' : ''` + `pct.toFixed(2)` + `'%'`.
- 시각 = `candleTooltipModel.kstLabels`와 **동일 규칙**(`new Date(tsMs + 9h)` + getUTC) 재현,
  단 구분자는 레퍼런스 이미지에 맞춰 점(`MM.DD`) 사용. `isMinuteTimeframe(tf)` 면 ` HH:MM` 부착, 아니면 날짜만.
- 단위 테스트 대상(부호·반올림·자릿수·분/캘린더 분기·자정 경계).

### 3) 오버레이 — `HighLowAnnotationOverlay.tsx` (PaneLegendOverlay 동형)

Props: `{ chart: IChartApi; bundle: RangeBundle; axis: VirtualAxis; paneSeries: PaneSeriesMap }`.

- `const enabled = useActivePrefs(p => p.highLowLabelsEnabled)` — false면 `null` 렌더(구독도 안 검).
- `subscribeVisibleLogicalRangeChange` + `ResizeObserver`를 한 rAF tick으로 coalesce(PaneLegendOverlay 패턴),
  tick마다 재렌더. cleanup에서 해제.
- 렌더 시점: `series = paneSeries.get('candle')`; `range = chart.timeScale().getVisibleRange()`;
  `currentPrice = bundle.candles.at(-1)?.close ?? null`;
  `ex = computeVisibleExtremes(bundle.candles, axis, range, currentPrice)`. `ex == null` → 라벨 없음.
- 좌표: `x = chart.timeScale().timeToCoordinate(virtualSec as Time)`, `y = series.priceToCoordinate(price)`.
  둘 중 하나라도 null이면 그 라벨 skip(우측 빈 띠·범위 밖 안전). 캔들은 pane 0이라 y 오프셋 불필요
  (PaneLegendOverlay paneTops[0]=0와 동일 전제).
- DOM: 컨테이너 `position:absolute; inset:0; pointer-events:none; zIndex`(PaneLegendOverlay 동일).
  고가/저가 각각 — 작은 점(`--price-up`/`--price-down`) + 라벨 div. 라벨은 고가=점 위, 저가=점 아래로
  오프셋. 색·폰트·간격은 DESIGN.md 토큰(`--font-mono`, `--text-xs`, `--space-*`).

### 4) 설정 토글 — `chartPrefs.ts` (CHART_TOGGLES 1줄)

```ts
{
  key: 'highLowLabelsEnabled',
  label: '고저 극값 라벨',
  description: '현재 보이는 차트 범위의 최고가·최저가 봉에 현재가의 극값 대비율(가격·%·시각) 라벨을 표시합니다.',
  default: true,
  category: 'chart',   // 생략 시 'chart' 기본 — 명시
}
```

> 라벨/설명 문구는 글로서리 **등락률**과의 충돌을 피해 "극값 대비율"로 표기(그릴링 확정). 토글명은 글로서리
> 용어 **High/Low Extreme Labels (고저 극값 라벨)**과 일치.

`ChartViewPrefs`·`DEFAULT_PREFS`·설정 UI("차트" 섹션 토글 행)·persistence가 전부 이 1줄에서 파생.
persistence(`chartPrefsPersistence.mergePrefs`)가 토글 키를 일반적으로 머지하는지 구현 시 확인(필요 시 1줄).

### 5) 마운트 — `LiveChartRoot.tsx` (1줄)

기존 오버레이 군집(`MovingAverageOverlay`/`LiveCurrentPriceLine`/`DrawingOverlay`/`PaneLegendOverlay`) 옆에:

```tsx
<HighLowAnnotationOverlay chart={chart} bundle={cb} axis={axis} paneSeries={paneSeries} />
```

`cb`(chartBundle, 안정) 사용 → SSE 호가 틱에 재렌더 없음. memo로 감싼다(PaneLegendOverlay 선례).

## Testing

### Unit — `computeVisibleExtremes` (순수)

| Case | Setup | Expected |
|------|-------|----------|
| 기본 극값 | 보이는 봉 high {…,38800,…} low {…,36750,…}, 현재가 37100 | high.price=38800 pct=(37100-38800)/38800·100≈-4.38; low.price=36750 pct≈+0.95 |
| 범위 필터 | 일부 봉이 visibleRange 밖(가상초) | 범위 안 봉만 고려 |
| axis.contains skip | 그려지지 않는(contains=false) 봉이 더 극단 | 그 봉 무시 |
| 동률 안정성 | 같은 high 2봉 | 첫 발생 유지 |
| null 가드 | visibleRange=null / candles=[] / currentPrice=null | `null` |
| 보이는 봉 0 | 범위가 데이터 사이 빈 구간 | `null` |
| 현재가=극값 | currentPrice == low.price | low.pct=0 (부호 +) |

### Unit — `formatExtremeLabel` (순수)

| Case | Input | Expected |
|------|-------|----------|
| 분봉 음수 | 38800, -4.379, tsMs(06.12 09:51 KST), '1m' | `38,800원 (-4.38%, 06.12 09:51)` |
| 분봉 양수 | 36750, 0.952, …14:51, '5m' | `36,750원 (+0.95%, 06.12 14:51)` |
| 캘린더 | 38800, -4.38, …, 'D' | `38,800원 (-4.38%, 06.12)`(시각 없음) |
| 자정 경계 | tsMs가 KST 00:xx 근처 | +9h 규칙으로 날짜·시각 정합(9h 어긋남 없음) |
| 천단위 | 1234567 | `1,234,567원 …` |

### Component — `HighLowAnnotationOverlay`

- 토글 off(`highLowLabelsEnabled=false`) → 라벨 미렌더.
- mock chart(`getVisibleRange`/`timeToCoordinate`/`priceToCoordinate`/`subscribeVisibleLogicalRangeChange`)
  + bundle/axis → 고가·저가 라벨 2개 텍스트 렌더(PaneLegendOverlay.test 패턴 재사용).
- `timeToCoordinate`/`priceToCoordinate` null → 해당 라벨 skip, crash 없음.

### Manual verification (/live, `/browse`)

- /live 분봉에서 고가 봉=빨강 라벨(음수%)·저가 봉=파랑 라벨(양수%)이 해당 봉에 뜬다.
- 팬/줌으로 보이는 범위를 바꾸면 극값·라벨이 따라 갱신.
- 종목/타임프레임 전환 시 갱신. D/W/M은 시각 없는 날짜 라벨.
- 설정창 "차트" → "고가/저가 등락률 라벨" 토글 off 시 사라진다.
- 라이브 틱으로 현재가가 움직이면 등락률 %가 갱신(cb 캔들 갱신 시).

## Risks / Open questions

- **`getVisibleRange()` 가상초 단위 정합**: 캔들 time은 `axis.toVirtual(ts_ms)/1000`(가상초)다.
  `getVisibleRange()`도 같은 가상초를 반환하므로 직접 비교 가능 — 구현 시 1개 실측 봉으로 확인.
- **우측 빈 띠 좌표 null**(메모리 `drawing-empty-band-coordinate`): 극값 봉이 우측 rightOffset 빈 띠에
  걸리는 일은 드물지만(극값은 데이터 봉) `timeToCoordinate` null 가드로 안전.
- **라벨 겹침**: 고가·저가가 화면상 가깝거나 현재가 라인/툴팁과 겹칠 수 있음 — v1 단순 오프셋, 평가 후 조정.
- **pane y 오프셋**: 캔들이 pane 0이 아닌 구성(현재 없음)이면 priceToCoordinate y에 paneTop 보정 필요 —
  현재 캔들은 항상 pane 0이라 불필요(PaneLegendOverlay와 동일 전제).
- **persistence 머지**: 새 토글 키가 `mergePrefs`에서 자동 머지되는지 구현 시 확인(토글은 일반 머지일 가능성 높음).
- **성능(O(N) 스캔)**: 극값 탐색은 rAF당 `bundle.candles` 1회 선형 스캔. PaneLegendOverlay도 동일 cadence로
  `series.data()` O(N) readback을 하므로 일관(선례). 최악 1m·250일 ~97k봉 → rAF당 ~0.5ms로 허용 범위.
  필요 시 백로그: visible range 실ms 경계로 이진탐색해 O(visible+logN)로 축소(candles는 ts_ms 정렬).
  SSE 호가 틱엔 재계산 안 함(memo + cb 안정) — 비용은 팬/줌 중에만 발생.

## Out of Scope (Backlog)

- 라벨 충돌 회피 알고리즘(고가/저가/현재가/툴팁 간).
- 극값 외 통계 라벨, 다구간 비교.
- 백엔드 연동·알림(이 기능은 순수 프론트 표시).
