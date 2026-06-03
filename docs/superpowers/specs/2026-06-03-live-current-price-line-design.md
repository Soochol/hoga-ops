# Live 현재가 라인 (Current Price Line) — Design

**Date**: 2026-06-03
**Status**: Draft
**Scope**: `frontend/src/live/LiveCurrentPriceLine.tsx` (신규), `frontend/src/live/deriveCurrentPriceLine.ts` (신규), `frontend/src/live/LiveChartRoot.tsx` (오버레이 마운트 1줄)

## Problem

사용자 요청(인용): *"캔들 차트에서 캔들 마지막 종가에 수평선 라인 그리기, y축에 현재 가격 라벨 표시."*

현재 /live 캔들 차트는 마지막 캔들의 종가(=현재가)를 차트 위 수평 기준선으로 보여주지 않는다. 현재가는 **Live Status Bar**(`LiveStatusBar.tsx:50`, `currentPrice = lastCandle?.close`)에 텍스트로만 있어, 차트의 어느 가격대에 현재가가 위치하는지 시각적으로 즉시 읽기 어렵다. 키움/TradingView식 "현재가 라인 + y축 가격 태그"가 없다.

## Invariants

이 spec이 건드리는 시스템이 **현재 보존하고 있는** 속성들:

- **전역 series 옵션 컨벤션**: 모든 lightweight-charts 시리즈는 `priceLineVisible: false` + `lastValueVisible: false`로 생성된다 (캔들·볼륨·호가비·체결강도·이동평균·총잔량 전부). 근거: `frontend/src/chart/projectors/*.ts`, `MovingAverageOverlay.tsx`, 커밋 `1e4dd3c`("convention unchanged").
- **제네릭 candle projector 순수성**: `chart/projectors/candle.ts`와 `RangeSeriesPane`는 `RangeBundle` + `VirtualAxis`만 받는다 — /live 전용 소스(LiveQuote 등)에 의존하지 않아 히스토리컬 뷰에서도 재사용된다. 근거: `RangeSeriesPane.tsx` JSDoc("deep module for any indicator derived from a RangeBundle").
- **현재가 단일 산출**: 차트/상태바가 말하는 "현재가" = `bundle.candles[last].close`. 근거: `LiveStatusBar.tsx:47-50`.
- **이중 소스 분리(dual-source)**: 현재가는 RangeBundle/WS에서, 전일 대비 등락(`change_pct`/`change_won`)은 KIS `intstock-multprice` 10초 폴(`useQuoteByCode`)에서 온다 — 의도적으로 분리된 두 realm. 근거: CONTEXT.md "Live Quote" 항목, `LiveStatusBar.tsx:38-40`.
- **VirtualAxis 가격 무변환**: 시간만 가상축으로 압축하고 가격(원)은 실제값을 price scale에 그대로 표시한다. 근거: `util/virtualAxis.ts` (`toVirtual`는 시간만 변환).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 전역 series 옵션 컨벤션 | **preserves** | 캔들 시리즈 옵션을 건드리지 않는다. 내장 `lastValueVisible`/`priceLineVisible`을 켜는 대신 **별도 `series.createPriceLine()`** 으로 현재가 라인을 그린다 → 컨벤션 위반 아님. |
| 제네릭 candle projector 순수성 | **preserves** | LiveQuote 의존 로직을 projector가 아닌 **/live 전용 오버레이**(`LiveCurrentPriceLine`)에 둔다. projector·`RangeSeriesPane`는 무변경. |
| 현재가 단일 산출 | **preserves** | 라인 가격 = `bundle.candles[last].close` — 상태바와 **동일 값**. 새 invariant 강화: 차트 라인 ↔ 상태바 현재가 항상 일치. |
| 이중 소스 분리 | **preserves** | 가격은 bundle, 색(등락 방향)은 quote 폴 — 상태바가 이미 하는 동일 페어링을 그대로 따른다. |
| VirtualAxis 가격 무변환 | **preserves** | price line은 실제 원 가격을 받는다(시간축 무관). |

intentionally-breaks 없음.

## Goals

- 캔들 차트 위에 **현재가(마지막 캔들 종가) 수평 점선**을 그린다.
- price scale(y축)에 **현재가 가격 태그**를 표시한다(원화 ko-KR 포맷, 캔들 시리즈 기존 `priceFormat` 재사용).
- 라인/라벨 **색 = 전일 대비 등락 방향**: 현재가 > 전일종가 → 빨강(`--price-up`), < → 파랑(`--price-down`), 0/미정 → 중립(`--fg-dim`). **Live Status Bar의 등락률 색과 항상 일치**.
- 과거로 스크롤해도 라인은 **최신 캔들(현재가)에 고정**(native price line이라 자동).
- 항상 표시(사용자 토글 없음).

## Non-Goals

- 전일종가 기준선(별도 reference line) — 그리지 않음.
- 라인 위 on-chart title 텍스트 — 없음(요청은 y축 라벨만).
- 애니메이션/트랜지션.
- 예상체결가(장전) 표시 — 데이터 없음, 범위 밖.
- 사용자 토글(CHART_TOGGLES 항목) — 항상 ON.
- 캔들 시리즈 내장 `lastValueVisible`/`priceLineVisible` 활성화.

## Design

### 컴포넌트 구조

`DrawingOverlay`(`chart/DrawingOverlay.tsx`) / `MovingAverageOverlay`(`live/indicators/MovingAverageOverlay.tsx`) / `PaneLegendOverlay`와 **동일한 형제 오버레이 패턴**. `null`을 렌더하고 effect로 native price line의 생명주기를 관리. 신규 파일은 `frontend/src/live/LiveCurrentPriceLine.tsx`(LiveChartRoot 형제로 두어 import 거리 최소화).

```
LiveChartRoot (overlay 블록, ~398행)
  └─ <LiveCurrentPriceLine paneSeries={paneSeries} bundle={bundle} code={code} />
        ├─ series = paneSeries.get('candle')        // 캔들 primary series 핸들
        ├─ quote  = useQuoteByCode([code]).get(code) // 등락 방향 소스(10초 폴, 공유 캐시)
        ├─ model  = deriveCurrentPriceLine(bundle, quote, TOKENS)  // 순수 함수
        └─ effects: createPriceLine(1회) → applyOptions(가격/색 변경) → removePriceLine(언마운트)
```

### 순수 함수 — `deriveCurrentPriceLine.ts`

색·가격 산출을 부수효과 없는 함수로 분리(단위 테스트 대상):

```ts
import type { RangeBundle } from '../api/types';
import type { LiveQuote } from '../api/liveQuotes';

export type PriceLineModel = { price: number; color: string } | null;

export function deriveCurrentPriceLine(
  bundle: RangeBundle,
  quote: LiveQuote | undefined,
  colors: { up: string; down: string; neutral: string },
): PriceLineModel {
  const { candles } = bundle;
  if (candles.length === 0) return null;            // 캔들 없으면 라인 없음
  const price = candles[candles.length - 1].close;  // 상태바와 동일 산출
  // 색 basis = QuoteChange/priceDirClass 컨벤션과 동일(won ?? pct ?? 0).
  // 상태바는 won={null}을 넘겨 pct로 색칠하지만, 상승/하락 시 sign(won)===sign(pct)
  // 이므로 won 우선이어도 색은 동일. won-null+pct-값(OPEN 단계 일부 quote)에선
  // pct 부호로 폴백 → 상태바와 항상 일치. 둘 다 null(장전/무데이터)일 때만 중립.
  const basis = quote == null ? null : (quote.change_won ?? quote.change_pct ?? null);
  const color =
    basis == null || basis === 0 ? colors.neutral
      : basis > 0 ? colors.up
        : colors.down;
  return { price, color };
}
```

- 소스: `change_won ?? change_pct`(부호). 근거: 색 기준은 **Status Bar와 항상 일치**해야 하는데(Goal/Invariant), 상태바는 `change_pct`로 색칠한다(`LiveStatusBar.tsx:98` `<QuoteChange won={null} pct={quote.change_pct}/>` → `QuoteChange.tsx:11` `basis = won ?? pct ?? 0`). 백엔드(`kis_client.py:1035-1043`)는 OPEN 단계에 `change_won=null + change_pct=값`(부호코드 유효·등락액 필드 결측) quote를 만들 수 있어 `change_won` 단독 기준이면 라인=중립/상태바=방향색으로 invariant가 깨진다 — `won ?? pct` basis가 이를 막는다. (`change_pct`가 null이면 `change_won`도 항상 null이므로 역방향 비대칭은 없음.)
- 색 토큰은 컴포넌트에서 `resolveTokens`로 해석해 주입(`candle.ts`와 동일 `--price-up`/`--price-down`/`--fg-dim`) → 함수는 순수 유지. 부호→색 규칙(>0 빨강/<0 파랑/0·null 중립)은 `ui/priceDir.ts`의 `priceDirClass` 컨벤션과 동일(그쪽은 CSS 클래스 반환이라 직접 재사용 불가, 규칙만 미러).

### 컴포넌트 — `LiveCurrentPriceLine.tsx`

> **Import 주의 (`verbatimModuleSyntax: true`, `tsconfig.app.json:13`)**: 값/타입 import를 구분해야 tsc 통과.
> `LineStyle`은 **반드시 lightweight-charts의 enum**(값 import) — 프로젝트 자체 `LineStyle`(문자열 유니온, `chart/drawing/types.ts:82`)과 **이름 충돌**하므로 거기서 import하면 `.Dashed` 멤버 없음으로 tsc 레드.
> ```ts
> import { useEffect, useRef } from 'react';
> import { LineStyle } from 'lightweight-charts';                       // 값(enum)
> import type { IPriceLine, ISeriesApi, PriceLineOptions } from 'lightweight-charts';
> import type { RangeBundle } from '../api/types';
> import type { PaneId } from '../chart/drawing/types';
> import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
> import { useQuoteByCode } from '../api/liveQuotes';
> import { resolveTokens } from '../util/tokens';
> import { deriveCurrentPriceLine } from './deriveCurrentPriceLine';
> ```

```tsx
const TOKENS = resolveTokens({
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
  neutral: ['--fg-dim', '#94A3B8'],
});

type Props = { paneSeries: PaneSeriesMap; bundle: RangeBundle; code: string | null };

export default function LiveCurrentPriceLine({ paneSeries, bundle, code }: Props) {
  const series = paneSeries.get('candle' as PaneId);
  const quote = useQuoteByCode(code ? [code] : []).get(code ?? '');
  const model = deriveCurrentPriceLine(bundle, quote, TOKENS);
  const lineRef = useRef<IPriceLine | null>(null);

  // 생성: 시리즈 핸들당 1회 (코드/타임프레임 변경 시 pane remount → 재생성)
  useEffect(() => {
    if (!series) return;
    // `as PriceLineOptions`: lightweight-charts가 lineVisible 등을 required로
    // 선언하나 런타임은 optional 취급 — 기존 검증 선례 zeroBaseline.ts:29 와 동일.
    const line = series.createPriceLine({
      price: model?.price ?? 0,
      color: model?.color ?? TOKENS.neutral,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineVisible: model != null,
      axisLabelVisible: model != null,
      axisLabelColor: model?.color ?? TOKENS.neutral,
      title: '',
    } as PriceLineOptions);
    lineRef.current = line;
    return () => {
      try { series.removePriceLine(line); } catch { /* chart already torn down */ }
      lineRef.current = null;
    };
    // model은 생성 시점값만 사용(이후 update effect가 보정) — RangeSeriesPane와 동일 의도적 deps 분리
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  // 갱신: 가격/색 변경 시에만 (원시값 deps)
  useEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    if (!model) { line.applyOptions({ lineVisible: false, axisLabelVisible: false }); return; }
    line.applyOptions({
      price: model.price, color: model.color, axisLabelColor: model.color,
      lineVisible: true, axisLabelVisible: true,
    });
  }, [model?.price, model?.color]);

  return null;
}
```

핵심: `createPriceLine`은 시리즈당 1회, 이후엔 `applyOptions`로만 갱신 → 매 틱 재생성으로 인한 깜빡임 방지.

### 데이터 흐름 / 갱신 트리거

- **새 캔들**(bundle 갱신) → `model.price` 변경 → update effect → `applyOptions({ price })`.
- **등락 방향 변경**(10초 quote 폴) → `model.color` 변경 → `applyOptions({ color, axisLabelColor })`.
- **종목 변경**(`code`) → candle pane remount → `paneSeries`의 'candle' 재등록 → 새 series 핸들 → create effect 재실행(이전 라인은 cleanup으로 제거).
- **폴 공유**: `code`는 `LiveWorkarea`에서 `LiveChartRoot code={activeCode}`로 내려오므로 `LiveStatusBar`의 `activeCode`와 **동일 값**. `useQuoteByCode([code])`가 만드는 queryKey(`['live-quotes', [...codes].sort().join(',')]`, `liveQuotes.ts:28-31`)가 상태바의 단일코드 호출과 동일 → react-query가 **두 호출을 1개 폴로 dedup**(추가 네트워크 없음). (Watchlist/Screener는 전체 코드 배열을 넘겨 다른 키 → 별개 폴이지만 무관.)

> **SSE 틱 식별자 churn 함정 회피** (메모리 교훈 `live_bundle_identity_churn_crosshair_overlay`): `bundle.candles`는 SSE 틱마다 새 식별자를 받는다. 오버레이 effect가 `bundle` 객체나 bundle-파생 memo를 deps에 넣으면 틱마다 재실행된다. 본 설계는 update effect deps를 **원시값**(`model?.price`, `model?.color`)으로만 두고 create effect deps는 `[series]`(remount 시에만 변경) — 따라서 매 틱 재구독/재생성이 없다. `model`은 매 렌더 재계산되지만(cheap) 객체 자체는 deps에 들어가지 않는다.

### 색·스타일

- 라인: 점선(`LineStyle.Dashed`), `lineWidth: 1`, 색 = 방향색. on-chart title 없음.
- y축 라벨: `axisLabelVisible: true`, 배경(`axisLabelColor`) = 방향색, 가격 텍스트 = 캔들 시리즈 `priceFormat`(원화 반올림 ko-KR) 상속.
- DESIGN.md 토큰만 사용(하드코딩 색은 resolveTokens 폴백값으로만).

### 적용 범위 / 엣지 케이스

- **타임프레임**: 분봉·D·W·M 전부(동일 primary candle series). 특별 분기 없음.
- **동시호가 muted window(15:20–15:30)**: 캔들 바디는 회색으로 muted 되지만 **현재가 라인은 방향색 유지**(사용자 결정). 라인은 "가격 레벨 vs 전일" 신호라 바디 muting과 목적이 다름.
- **장전(change 필드 null)**: 중립색. 오늘 캔들이 아직 없으면 마지막 캔들 = 직전 거래일 종가(라인은 거기에 표시).
- **quote 미수신/에러**: 중립색, 라인은 마지막 캔들 종가에 유지(robust).
- **캔들 0개**: 라인 숨김(`lineVisible: false`).
- **과거 스크롤**: native price line은 가격 고정이라 자동으로 현재가에 머무름.

## Testing

### Unit tests — `deriveCurrentPriceLine.test.ts`

| Case | Setup | Expected |
|------|-------|----------|
| 빈 캔들 | `candles: []` | `null` |
| 상승 | last close=70000, `change_won`=+500, `change_pct`=+0.7 | `{ price:70000, color: up }` |
| 하락 | `change_won`=-300, `change_pct`=-0.4 | `{ ..., color: down }` |
| 보합 | `change_won`=0, `change_pct`=0 | `{ ..., color: neutral }` |
| **won-null+pct-값 폴백** | `change_won`=null, `change_pct`=+1.2 | `{ ..., color: up }` ← 상태바와 일치(핵심) |
| 둘 다 null (장전) | `change_won`=null, `change_pct`=null | `{ ..., color: neutral }` |
| quote 없음 | `quote=undefined` | `{ ..., color: neutral }` |
| 가격 산출 | candles 다수 | `price === candles.at(-1).close` |

### Component tests — `LiveCurrentPriceLine.test.tsx`

가짜 series(createPriceLine/removePriceLine/applyOptions 스파이) + paneSeries Map mock. 패턴 참조: `frontend/src/live/indicators/MovingAverageOverlay.test.tsx`, `frontend/src/live/LiveChartRoot.test.tsx`.

> **QueryClient 필수**: `LiveCurrentPriceLine`은 `useQuoteByCode`(→ `useQuery`)를 호출하므로 테스트는 `QueryClientProvider`로 감싸야 한다(`LiveChartRoot.test.tsx:80-82`의 `wrapper` 패턴). 색 변경 케이스는 wrapper의 QueryClient 캐시에 quote를 `setQueryData(['live-quotes', code], …)`로 심거나 `vi.mock('../api/liveQuotes')`로 `useQuoteByCode` 반환 Map을 갈아끼워 검증.

| Case | Expected |
|------|----------|
| 마운트(candle series 존재) | `createPriceLine` 1회 호출, 옵션에 `lineStyle: LineStyle.Dashed`·`axisLabelVisible: true` |
| 가격 변경(bundle 갱신) | `applyOptions({ price })` 호출, `createPriceLine` 재호출 없음 |
| 색 변경(quote 갱신) | `applyOptions({ color, axisLabelColor })` |
| candle series 부재 | no-op(생성 안 함) |
| 언마운트 | `removePriceLine` 호출 |

**Invariant 회귀 테스트**: "전역 series 옵션 컨벤션" — `candle.ts`의 `priceLineVisible: false`/`lastValueVisible: false`가 유지됨을 기존 테스트가 계속 통과. "현재가 단일 산출" — `deriveCurrentPriceLine`의 price가 `candles.at(-1).close`임을 단위 테스트로 고정.

### Manual verification (`/live`)

1. 캔들 차트에 현재가 위치 수평 점선 + y축 가격 태그 표시.
2. 라인/라벨 색이 Status Bar 등락률(%) 색과 **일치**.
3. 과거로 스크롤 → 라인은 현재가에 고정(따라 움직이지 않음).
4. 종목 변경 → 라인 가격/색 갱신.
5. 타임프레임 분/D/W/M 전환 → 라인 유지.
6. (가능하면) 장전 상태 → 중립색.

## Risks / Open questions

검증 워크플로우(2026-06-03, 6 fact-checker + 완전성 비평)로 아래 사항 **확정(confirmed)**:

- ✅ **price line 라벨 포맷**: lightweight-charts 런타임 소스(`CustomPriceLinePriceAxisView` → `priceScale.formatPrice` → 시리즈 custom formatter)상 axis label이 시리즈 `priceFormat`(원화 ko-KR)을 **상속함**. 단 조건: chart-level `localization.priceFormatter`가 unset이어야 함(현재 `LiveChartRoot.tsx:222`는 timeFormatter만 설정 → 충족). price line을 ko-KR 캔들 시리즈에 생성하므로 OK.
- ✅ **change null 게이팅**: 장전엔 `change_won`·`change_pct`가 **함께** null(`api.py:390-394` 단일 `pre` 플래그). 단 `change_won`은 OPEN 단계에서도 단독 null 가능(부호코드 유효+등락액 결측, `kis_client.py:1035-1043`) → 그래서 색 basis를 `won ?? pct`로 확정(위 Design 반영). `change_pct` null이면 `change_won`도 항상 null이라 역방향 비대칭 없음.
- ✅ **react-query 폴 공유**: `code === activeCode`(`LiveWorkarea`), 둘 다 단일코드 `[code]` → 동일 queryKey → 상태바 폴과 dedup.
- ✅ **`'candle'` PaneId**: `CANDLE_SPEC.name === 'candle' as const`(`candle.ts:45`), `'candle'`은 `PaneId` 유니온 첫 멤버(`chart/drawing/types.ts:30`). `PaneSeriesMap = ReadonlyMap<PaneId, ISeriesApi<any>>`(`chart/drawing/chartCoordinates.ts:20`).

남은 open questions:

- **createPriceLine 타입 캐스트**: `as PriceLineOptions` 필요 여부는 node_modules 설치 후 tsc로 최종 확인(선례 `zeroBaseline.ts:29`는 캐스트함). 구현 시 검증.
- **D/W/M에서의 의미**: 월봉에 "전일 대비" 현재가 라인은 다소 어색하나 무해. 필요 시 후속으로 분봉 한정 게이팅.

## Out of Scope (Backlog)

- 전일종가 기준선(별도 dashed reference line) — 원하면 같은 메커니즘으로 추가 가능.
- 사용자 토글(CHART_TOGGLES "현재가 라인").
- 호버 시 라인에 등락액/등락률 툴팁.
