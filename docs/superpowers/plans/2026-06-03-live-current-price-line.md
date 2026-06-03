# Live 현재가 라인 (Current Price Line) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /live 캔들 차트에 마지막 캔들 종가 수평 점선 + y축 가격 태그를 그리고, 색을 전일 대비 등락 방향(Status Bar와 일치)으로 표시한다.

**Architecture:** 캔들 시리즈 옵션은 손대지 않고(전역 `priceLineVisible/lastValueVisible=false` 컨벤션 보존), /live 전용 오버레이 컴포넌트가 `paneSeries`로 캔들 primary series 핸들을 받아 native `series.createPriceLine()` 하나를 걸어 라인+라벨을 동시에 그린다. 색·가격 산출은 순수 함수로 분리해 단위 테스트한다. DrawingOverlay/MovingAverageOverlay와 동일한 형제 오버레이 패턴.

**Tech Stack:** React, TypeScript (verbatimModuleSyntax), lightweight-charts v5.2, @tanstack/react-query, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-03-live-current-price-line-design.md`

---

## File Structure

| 파일 | 책임 | 신규/수정 |
|------|------|-----------|
| `frontend/src/live/deriveCurrentPriceLine.ts` | 순수 함수 — (bundle, quote, colors) → `{price, color}` \| null | 신규 |
| `frontend/src/live/deriveCurrentPriceLine.test.ts` | 순수 함수 단위 테스트 | 신규 |
| `frontend/src/live/LiveCurrentPriceLine.tsx` | 오버레이 — paneSeries['candle']에 price line 생명주기 관리 | 신규 |
| `frontend/src/live/LiveCurrentPriceLine.test.tsx` | 오버레이 컴포넌트 테스트 | 신규 |
| `frontend/src/live/LiveChartRoot.tsx` | 오버레이 블록에 마운트 1줄 + import | 수정 |

**검증된 사실(스펙 검증 워크플로우 2026-06-03):** `LiveQuote = { code, price, change_pct: number\|null, change_won: number\|null }` (`api/liveQuotes.ts:6`). `useQuoteByCode(codes) → Map<string, LiveQuote>`, `.get(code) → LiveQuote\|undefined`. `resolveTokens`는 DOM 없거나 CSS 미설정 시 fallback hex 반환(`util/tokens.ts`). `PaneSeriesMap = ReadonlyMap<PaneId, ISeriesApi<any>>` (`chart/drawing/chartCoordinates.ts:20`), `'candle' ∈ PaneId` (`chart/drawing/types.ts:30`), `CANDLE_SPEC.name === 'candle'`. `createPriceLine`은 `as PriceLineOptions` 캐스트 선례 `chart/util/zeroBaseline.ts:29`(`lineStyle` 숫자 표기 `1=dotted`, 우리는 `2=dashed`). `LiveChartRoot.tsx`는 `code: string|null` prop을 가지며 오버레이 블록(`~379-417행`)에서 `chart`/`bundle`(non-null narrowed)/`paneSeries`/`code` 모두 스코프에 있음. LiveChartRoot.test의 lightweight-charts mock은 이미 `createPriceLine`/`removePriceLine`를 포함(호출횟수 단언 없음) → 통합 회귀 안전.

---

## Task 0: 워크트리 의존성 설치 + 베이스라인 green

새 워크트리는 `frontend/node_modules`가 비어 있다(`vite: not found` 증상). 구현 전 1회 설치하고 베이스라인을 확인한다.

**Files:** 없음(환경 준비)

- [ ] **Step 1: 의존성 설치**

Run:
```bash
cd frontend && npm install
```
Expected: 설치 완료(이미 설치돼 있으면 즉시 종료).

- [ ] **Step 2: 베이스라인 타입체크 green 확인**

Run:
```bash
cd frontend && npx tsc -b
```
Expected: 에러 없이 종료(베이스라인이 깨져 있으면 먼저 보고).

---

## Task 1: 순수 함수 `deriveCurrentPriceLine`

가격(마지막 캔들 종가) + 색(전일 대비 등락 방향) 산출을 부수효과 없는 함수로 분리.

**Files:**
- Create: `frontend/src/live/deriveCurrentPriceLine.ts`
- Test: `frontend/src/live/deriveCurrentPriceLine.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

Create `frontend/src/live/deriveCurrentPriceLine.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { deriveCurrentPriceLine } from './deriveCurrentPriceLine';
import type { RangeBundle } from '../api/types';
import type { LiveQuote } from '../api/liveQuotes';

const COLORS = { up: 'UP', down: 'DOWN', neutral: 'NEUTRAL' };

function bundleWith(closes: number[]): RangeBundle {
  return {
    candles: closes.map((c, i) => ({
      ts_ms: i * 1000, open: c, close: c, high: c, low: c, vol_a: 0, vol_b: 0,
    })),
  } as RangeBundle;
}

function quote(over: Partial<LiveQuote>): LiveQuote {
  return { code: '005930', price: 0, change_pct: null, change_won: null, ...over };
}

describe('deriveCurrentPriceLine', () => {
  it('returns null when there are no candles', () => {
    expect(deriveCurrentPriceLine(bundleWith([]), undefined, COLORS)).toBeNull();
  });

  it('uses the last candle close as the price', () => {
    const m = deriveCurrentPriceLine(
      bundleWith([100, 200, 70000]),
      quote({ change_won: 0, change_pct: 0 }),
      COLORS,
    );
    expect(m).toEqual({ price: 70000, color: 'NEUTRAL' });
  });

  it('colors up when change_won is positive', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: 500, change_pct: 0.7 }), COLORS);
    expect(m?.color).toBe('UP');
  });

  it('colors down when change_won is negative', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: -300, change_pct: -0.4 }), COLORS);
    expect(m?.color).toBe('DOWN');
  });

  it('falls back to change_pct sign when change_won is null (OPEN-phase quote)', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: null, change_pct: 1.2 }), COLORS);
    expect(m?.color).toBe('UP');
  });

  it('is neutral when both change fields are null (pre-open)', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: null, change_pct: null }), COLORS);
    expect(m?.color).toBe('NEUTRAL');
  });

  it('is neutral when quote is undefined', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), undefined, COLORS);
    expect(m?.color).toBe('NEUTRAL');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run:
```bash
cd frontend && npx vitest run src/live/deriveCurrentPriceLine.test.ts
```
Expected: FAIL — `Failed to resolve import "./deriveCurrentPriceLine"` (모듈 없음).

- [ ] **Step 3: 최소 구현 작성**

Create `frontend/src/live/deriveCurrentPriceLine.ts`:
```ts
import type { RangeBundle } from '../api/types';
import type { LiveQuote } from '../api/liveQuotes';

export type PriceLineColors = { up: string; down: string; neutral: string };
export type PriceLineModel = { price: number; color: string } | null;

/**
 * 현재가 라인의 가격·색을 산출하는 순수 함수.
 *  - price = 마지막 캔들 종가 (LiveStatusBar 의 현재가와 동일 산출).
 *  - color basis = change_won ?? change_pct (QuoteChange/priceDirClass 컨벤션과 동일):
 *    >0 빨강 / <0 파랑 / 0·null 중립. won 우선이나 won-null+pct-값(OPEN 단계 일부
 *    quote, kis_client.py)에선 pct 부호로 폴백해 Status Bar 색과 항상 일치한다.
 */
export function deriveCurrentPriceLine(
  bundle: RangeBundle,
  quote: LiveQuote | undefined,
  colors: PriceLineColors,
): PriceLineModel {
  const { candles } = bundle;
  if (candles.length === 0) return null;
  const price = candles[candles.length - 1].close;
  const basis = quote == null ? null : (quote.change_won ?? quote.change_pct ?? null);
  const color =
    basis == null || basis === 0
      ? colors.neutral
      : basis > 0
        ? colors.up
        : colors.down;
  return { price, color };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run:
```bash
cd frontend && npx vitest run src/live/deriveCurrentPriceLine.test.ts
```
Expected: PASS (7 tests).

- [ ] **Step 5: 타입체크 + 커밋**

Run:
```bash
cd frontend && npx tsc -b
cd .. && git add frontend/src/live/deriveCurrentPriceLine.ts frontend/src/live/deriveCurrentPriceLine.test.ts
git commit -m "$(printf 'feat(live): deriveCurrentPriceLine 순수 함수\n\n현재가 라인의 가격(마지막 캔들 종가)+색(change_won ?? change_pct 부호)\n산출. Status Bar 색과 일치.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```
Expected: tsc 에러 없음, 커밋 생성.

---

## Task 2: 오버레이 컴포넌트 `LiveCurrentPriceLine`

캔들 primary series에 native price line 하나를 걸어 생성·갱신·제거를 관리.

**Files:**
- Create: `frontend/src/live/LiveCurrentPriceLine.tsx`
- Test: `frontend/src/live/LiveCurrentPriceLine.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

Create `frontend/src/live/LiveCurrentPriceLine.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// useQuoteByCode 를 모킹해 react-query/네트워크 없이 quote 를 직접 주입.
vi.mock('../api/liveQuotes', () => ({ useQuoteByCode: vi.fn(() => new Map()) }));
import { useQuoteByCode } from '../api/liveQuotes';
import LiveCurrentPriceLine from './LiveCurrentPriceLine';
import { resolveTokens } from '../util/tokens';
import type { RangeBundle } from '../api/types';
import type { LiveQuote } from '../api/liveQuotes';

const mockUseQuoteByCode = vi.mocked(useQuoteByCode);

// 컴포넌트와 동일한 토큰 해석 — CSS 로드 여부와 무관하게 색 출처를 검증.
const T = resolveTokens({
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
  neutral: ['--fg-dim', '#94A3B8'],
});

function makeSeriesMock() {
  const priceLine = { applyOptions: vi.fn() };
  return { priceLine, createPriceLine: vi.fn(() => priceLine), removePriceLine: vi.fn() };
}

function bundleWith(closes: number[]): RangeBundle {
  return {
    candles: closes.map((c, i) => ({
      ts_ms: i * 1000, open: c, close: c, high: c, low: c, vol_a: 0, vol_b: 0,
    })),
  } as RangeBundle;
}

function quoteMap(over: Partial<LiveQuote>): Map<string, LiveQuote> {
  return new Map([['005930', { code: '005930', price: 0, change_pct: null, change_won: null, ...over }]]);
}

describe('LiveCurrentPriceLine', () => {
  beforeEach(() => {
    cleanup();
    mockUseQuoteByCode.mockReturnValue(new Map());
  });

  it('creates one price line on the candle series at mount', () => {
    const s = makeSeriesMock();
    const paneSeries = new Map([['candle', s]]);
    mockUseQuoteByCode.mockReturnValue(quoteMap({ change_won: 500, change_pct: 0.7 }));
    render(<LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />);
    expect(s.createPriceLine).toHaveBeenCalledTimes(1);
    const opts = s.createPriceLine.mock.calls[0][0];
    expect(opts).toMatchObject({ price: 70000, lineStyle: 2, axisLabelVisible: true });
    expect(opts.color).toBe(T.up); // 상승 → up 토큰
  });

  it('updates price via applyOptions without recreating the line', () => {
    const s = makeSeriesMock();
    const paneSeries = new Map([['candle', s]]);
    mockUseQuoteByCode.mockReturnValue(quoteMap({ change_won: 500, change_pct: 0.7 }));
    const { rerender } = render(
      <LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />,
    );
    rerender(<LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000, 71000])} code="005930" />);
    expect(s.createPriceLine).toHaveBeenCalledTimes(1);
    expect(s.priceLine.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ price: 71000 }));
  });

  it('recolors via applyOptions when the quote direction flips', () => {
    const s = makeSeriesMock();
    const paneSeries = new Map([['candle', s]]);
    mockUseQuoteByCode.mockReturnValue(quoteMap({ change_won: 500, change_pct: 0.7 }));
    const { rerender } = render(
      <LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />,
    );
    mockUseQuoteByCode.mockReturnValue(quoteMap({ change_won: -300, change_pct: -0.4 }));
    rerender(<LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />);
    expect(s.priceLine.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ color: T.down }));
  });

  it('does nothing when the candle series is absent', () => {
    const paneSeries = new Map();
    expect(() =>
      render(<LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />),
    ).not.toThrow();
  });

  it('removes the price line on unmount', () => {
    const s = makeSeriesMock();
    const paneSeries = new Map([['candle', s]]);
    mockUseQuoteByCode.mockReturnValue(quoteMap({ change_won: 500, change_pct: 0.7 }));
    const { unmount } = render(
      <LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />,
    );
    unmount();
    expect(s.removePriceLine).toHaveBeenCalledWith(s.priceLine);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run:
```bash
cd frontend && npx vitest run src/live/LiveCurrentPriceLine.test.tsx
```
Expected: FAIL — `Failed to resolve import "./LiveCurrentPriceLine"`.

- [ ] **Step 3: 컴포넌트 구현 작성**

Create `frontend/src/live/LiveCurrentPriceLine.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import type { IPriceLine, PriceLineOptions } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import { useQuoteByCode } from '../api/liveQuotes';
import { resolveTokens } from '../util/tokens';
import { deriveCurrentPriceLine } from './deriveCurrentPriceLine';

// DESIGN.md 토큰 → 색 문자열(canvas 가 var(--…) 를 못 받음). candle.ts 와 동일 토큰.
const TOKENS = resolveTokens({
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
  neutral: ['--fg-dim', '#94A3B8'],
});

type Props = {
  paneSeries: PaneSeriesMap;
  bundle: RangeBundle;
  code: string | null;
};

/**
 * /live 캔들 차트의 현재가 라인 오버레이. 캔들 primary series 에 native price
 * line 하나를 걸어 (1) 마지막 캔들 종가 수평 점선 + (2) y축 가격 태그를 그린다.
 * 색은 전일 대비 등락 방향(Status Bar 와 동일, change_won ?? change_pct).
 * 캔들 시리즈 옵션은 건드리지 않아 전역 priceLineVisible/lastValueVisible=false
 * 컨벤션을 보존한다. 형제 패턴: DrawingOverlay / indicators/MovingAverageOverlay.
 * 설계 근거: docs/superpowers/specs/2026-06-03-live-current-price-line-design.md.
 */
export default function LiveCurrentPriceLine({ paneSeries, bundle, code }: Props) {
  const series = paneSeries.get('candle' as PaneId);
  const quote = useQuoteByCode(code ? [code] : []).get(code ?? '');
  const model = deriveCurrentPriceLine(bundle, quote, TOKENS);
  const lineRef = useRef<IPriceLine | null>(null);

  // 생성: 시리즈 핸들당 1회. code/타임프레임 변경 → candle pane remount →
  // 'candle' 재등록 → series 핸들 교체 → 재생성(이전 라인은 cleanup 제거).
  useEffect(() => {
    if (!series) return;
    // `as PriceLineOptions`: lightweight-charts 가 lineVisible 등을 required 로
    // 선언하나 런타임은 optional 취급 — 선례 chart/util/zeroBaseline.ts:29.
    const line = series.createPriceLine({
      price: model?.price ?? 0,
      color: model?.color ?? TOKENS.neutral,
      lineWidth: 1,
      lineStyle: 2, // dashed (= LineStyle.Dashed; zeroBaseline.ts 와 동일 숫자 표기)
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
    // model 은 생성 시점값만 사용(이후 update effect 가 보정). series 핸들 churn
    // 방지를 위해 deps 는 [series] 만 — RangeSeriesPane 의 동일 의도적 분리.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  // 갱신: 가격/색 변경 시에만. deps 는 원시값 — bundle.candles 가 SSE 틱마다 새
  // 식별자를 받아도 이 effect 는 재실행 안 됨(메모리: live_bundle_identity_churn).
  useEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    if (!model) {
      line.applyOptions({ lineVisible: false, axisLabelVisible: false });
      return;
    }
    line.applyOptions({
      price: model.price,
      color: model.color,
      axisLabelColor: model.color,
      lineVisible: true,
      axisLabelVisible: true,
    });
  }, [model?.price, model?.color]);

  return null;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run:
```bash
cd frontend && npx vitest run src/live/LiveCurrentPriceLine.test.tsx
```
Expected: PASS (5 tests).

- [ ] **Step 5: 타입체크 + 커밋**

Run:
```bash
cd frontend && npx tsc -b
cd .. && git add frontend/src/live/LiveCurrentPriceLine.tsx frontend/src/live/LiveCurrentPriceLine.test.tsx
git commit -m "$(printf 'feat(live): LiveCurrentPriceLine 오버레이\n\n캔들 primary series 에 native price line(점선+y축 태그) 생성·갱신·제거.\n색=전일 대비 방향. 캔들 시리즈 옵션 불변(컨벤션 보존).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```
Expected: tsc 에러 없음, 커밋 생성.

---

## Task 3: LiveChartRoot 오버레이 마운트 + 회귀/수동 검증

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx` (import 1줄 + 오버레이 블록 마운트 1줄)

- [ ] **Step 1: import 추가**

`frontend/src/live/LiveChartRoot.tsx`의 기존 import 블록(다른 오버레이 import 근처, 예: `MovingAverageOverlay` import 줄 아래)에 추가:
```tsx
import LiveCurrentPriceLine from './LiveCurrentPriceLine';
```

- [ ] **Step 2: 오버레이 블록에 마운트**

`frontend/src/live/LiveChartRoot.tsx`의 `<MovingAverageOverlay chart={chart} bundle={bundle} axis={axis} />` 줄 **바로 아래**에 추가:
```tsx
          <LiveCurrentPriceLine paneSeries={paneSeries} bundle={bundle} code={code} />
```
(이 블록은 `{chart && bundle && axis.segments.length > 0 && ( ... )}` 안이라 `bundle`은 non-null로 narrowing됨. `paneSeries`·`code`는 같은 스코프에 있음.)

- [ ] **Step 3: 타입체크**

Run:
```bash
cd frontend && npx tsc -b
```
Expected: 에러 없음. (만약 `createPriceLine(... )` 옵션 객체에서 타입 에러가 나면 `as PriceLineOptions` 캐스트가 이미 적용돼 있는지 확인 — Task 2 코드에 포함됨.)

- [ ] **Step 4: 변경 파일 lint(0 에러) + 전체 테스트 회귀 green**

Run:
```bash
cd frontend && npx eslint src/live/LiveCurrentPriceLine.tsx src/live/deriveCurrentPriceLine.ts src/live/LiveChartRoot.tsx
npx vitest run
```
Expected: 변경 파일 eslint 0 에러(레포 전역 eslint debt는 무시 — 변경 파일만 게이트). `npx vitest run` 전체 green(LiveChartRoot.test 포함 — 그 mock은 이미 createPriceLine/removePriceLine 보유, 호출횟수 단언 없음 → 회귀 없음).

- [ ] **Step 5: 커밋**

Run:
```bash
cd .. && git add frontend/src/live/LiveChartRoot.tsx
git commit -m "$(printf 'feat(live): LiveChartRoot 에 현재가 라인 오버레이 마운트\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```
Expected: 커밋 생성.

- [ ] **Step 6: 수동 검증 (`/live`)**

dev 서버 기동(CLAUDE.md "Dev servers" 절):
```bash
# 백엔드(별도 터미널, .env에 KIS_APP_KEY/SECRET 필요)
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
# 프론트(별도 터미널)
cd frontend && npm run dev   # http://localhost:5173/live
```
체크리스트:
1. 캔들 차트에 현재가 위치 **수평 점선** + y축 **원화 가격 태그**(예 "70,000") 표시.
2. 라인/라벨 색이 Status Bar 등락률(%) 색과 **일치**(상승 빨강/하락 파랑).
3. 과거로 스크롤 → 라인은 현재가에 **고정**(따라 움직이지 않음).
4. 종목 변경 → 라인 가격/색 갱신.
5. 타임프레임 분/D/W/M 전환 → 라인 유지.
6. **라인이 체결마다 따라 움직이는지** 육안 확인 — `bundle.candles`(KIS 폴) vs SSE 틱 갱신 주기 확인용(설계 결함 아님; 갱신 체감만 기록).
7. y축 가격 태그 텍스트가 원화 ko-KR 포맷(반올림)으로 보이는지(미상속 시 원시 숫자 — 스펙 Risks 참조).

---

## Self-Review (작성자 점검 완료)

- **Spec coverage:** 마지막 캔들 종가 라인(Task 2) ✓, y축 가격 라벨(Task 2 axisLabelVisible) ✓, 전일 대비 색(Task 1 basis) ✓, 점선(Task 2 lineStyle:2) ✓, 항상 ON(토글 없음) ✓, 동시호가 색 유지(색은 quote 기준이라 auction 분기 없음 → 자동 유지) ✓, 마운트(Task 3) ✓.
- **Placeholder scan:** TBD/TODO 없음. 모든 step에 실제 코드/명령/기대출력 포함.
- **Type consistency:** `deriveCurrentPriceLine(bundle, quote, colors): PriceLineModel`가 Task 1 정의와 Task 2 호출에서 동일 시그니처. `PriceLineColors`={up,down,neutral}와 `TOKENS`(resolveTokens 키 up/down/neutral) 일치. `lineStyle: 2`(dashed)와 테스트 단언(`lineStyle: 2`) 일치. 색 토큰 폴백(#DC2626/#2563EB)과 테스트 단언 일치.
- **엣지:** 캔들 0개 → null → lineVisible false. quote 없음/장전 → 중립. series 부재 → no-op.
