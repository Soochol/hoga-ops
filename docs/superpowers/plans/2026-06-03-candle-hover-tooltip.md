# 캔들 호버 툴팁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/live` 차트에서 캔들에 마우스를 올리면 그 봉의 OHLC·직전대비(봉대비)·거래량·거래량비를 커서 추종 플로팅 툴팁으로 표시한다 (캔들 페인 한정, 호버 시에만, 설정 토글 기본 ON).

**Architecture:** 순수 모델(`candleTooltipModel.ts` — `buildCandleTooltip(candles, index, timeframe)` + `placeTooltip(...)`, 차트 API 미접근, 테이블 테스트) + 오버레이 컴포넌트(`CandleTooltip.tsx` — `subscribeCrosshairMove` 구독, 가상시각→index 맵으로 봉 해석, `paneIdAtY`로 캔들 페인 게이팅, `useActivePrefs`로 토글 게이팅). 기준은 **봉대비**(직전 그려진 봉 `candles[index-1]`, 전 타임프레임 동일 — ADR-0059). 전부 인메모리, 외부 페치 0.

**Tech Stack:** React 18 + TypeScript, lightweight-charts v5, Zustand(`useChartPrefsStore`), Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-03-candle-hover-tooltip-design.md` · **ADR:** `docs/adr/0059-candle-tooltip-bar-over-bar.md` · **용어:** `CONTEXT.md` 봉대비 / Candle Tooltip.

---

## File Structure

| File | 책임 | 생성/수정 |
|---|---|---|
| `frontend/src/live/candleTooltipModel.ts` | 순수 모델 + 위치 계산 (`buildCandleTooltip`, `placeTooltip`, 타입) | 생성 |
| `frontend/src/live/candleTooltipModel.test.ts` | 모델·위치 테이블 테스트 | 생성 |
| `frontend/src/state/chartPrefs.ts` | `CHART_TOGGLES`에 `candleTooltipEnabled` 엔트리 1개 추가 | 수정 (1줄 블록) |
| `frontend/src/state/chartPrefs.test.ts` | 토글 기본값·persist 테스트 | 생성 |
| `frontend/src/live/CandleTooltip.tsx` | 오버레이 컴포넌트 (구독·게이팅·렌더·위치) | 생성 |
| `frontend/src/live/CandleTooltip.test.tsx` | 컴포넌트 show/hide/content 테스트 | 생성 |
| `frontend/src/live/LiveChartRoot.tsx` | 오버레이 그룹에 `<CandleTooltip/>` 마운트 | 수정 (import + 1줄 JSX) |

검증 게이트(매 태스크): `cd frontend && npx vitest run <test>` + `cd frontend && npx tsc -b`. (eslint는 변경 파일 한정 — 레포 전체 `eslint .`는 기존 부채로 실패하므로 게이트 아님.)

---

## Task 1: 순수 모델 `buildCandleTooltip`

**Files:**
- Create: `frontend/src/live/candleTooltipModel.ts`
- Test: `frontend/src/live/candleTooltipModel.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/live/candleTooltipModel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildCandleTooltip } from './candleTooltipModel';
import type { Candle } from '../api/types';

// ts_ms 는 실 Unix ms (ADR-0003). 09:00 KST = baseMs.
const baseMs = 1779840000000;
const C = (
  tsMs: number, o: number, h: number, l: number, c: number, va: number, vb = 0,
): Candle => ({ ts_ms: tsMs, open: o, high: h, low: l, close: c, vol_a: va, vol_b: vb });

const bars: Candle[] = [
  C(baseMs + 0 * 60_000, 100, 105, 99, 102, 10),
  C(baseMs + 1 * 60_000, 102, 108, 101, 107, 20),
  C(baseMs + 2 * 60_000, 107, 110, 104, 105, 20), // 거래량 동일 → 100%
];

describe('buildCandleTooltip', () => {
  it('index 범위 밖이면 null', () => {
    expect(buildCandleTooltip(bars, -1, '1m')).toBeNull();
    expect(buildCandleTooltip(bars, 3, '1m')).toBeNull();
  });

  it('index 0 (직전 봉 없음) → 봉대비/거래량비 null, OHLC·거래량은 채움', () => {
    const m = buildCandleTooltip(bars, 0, '1m')!;
    expect(m.open).toBe(100);
    expect(m.close).toBe(102);
    expect(m.volume).toBe(10);
    expect(m.barOverBarWon).toBeNull();
    expect(m.barOverBarPct).toBeNull();
    expect(m.volumeRatioPct).toBeNull();
  });

  it('상승봉: 봉대비 변동(액·률) + 거래량비 = 직전 봉 대비', () => {
    const m = buildCandleTooltip(bars, 1, '1m')!;
    expect(m.barOverBarWon).toBe(5);            // 107 - 102
    expect(m.barOverBarPct).toBeCloseTo((107 / 102 - 1) * 100, 6);
    expect(m.volume).toBe(20);
    expect(m.volumeRatioPct).toBe(200);          // 20 / 10 * 100
  });

  it('거래량 동일 → 거래량비 100%', () => {
    const m = buildCandleTooltip(bars, 2, '1m')!;
    expect(m.volumeRatioPct).toBe(100);          // 20 / 20 * 100
  });

  it('prevVolume===0 → 거래량비 null (0 나눗셈 회피)', () => {
    const zeroPrev = [C(baseMs, 100, 100, 100, 100, 0), C(baseMs + 60_000, 100, 101, 99, 100, 5)];
    expect(buildCandleTooltip(zeroPrev, 1, '1m')!.volumeRatioPct).toBeNull();
  });

  it('분봉: dateLabel MM/DD + timeLabel HH:MM (KST)', () => {
    const m = buildCandleTooltip(bars, 1, '1m')!;
    expect(m.dateLabel).toBe('05/27');           // baseMs+1m 의 KST 날짜
    expect(m.timeLabel).toBe('09:01');
  });

  it('D/W/M: timeLabel null, dateLabel YYYY/MM/DD', () => {
    const m = buildCandleTooltip(bars, 1, 'D')!;
    expect(m.timeLabel).toBeNull();
    expect(m.dateLabel).toBe('2026/05/27');
  });

  it('vol_a + vol_b 합을 거래량으로', () => {
    const split = [C(baseMs, 1, 1, 1, 1, 3, 4)];
    expect(buildCandleTooltip(split, 0, '1m')!.volume).toBe(7);
  });
});
```

> dateLabel 기대값(`05/27`, `2026/05/27`)은 `baseMs = 1779840000000` 의 KST 환산값이다. Step 4 에서 실제 출력이 다르면 **기대값을 실제 출력으로 맞추라**(포맷 로직이 맞는 한 — `new Date(ts_ms + 9h)` 기준). 핵심 단언은 봉대비·거래량비 수치다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/live/candleTooltipModel.test.ts`
Expected: FAIL — `buildCandleTooltip` is not defined / 모듈 없음.

- [ ] **Step 3: 모델 구현**

`frontend/src/live/candleTooltipModel.ts`:

```ts
import type { Candle } from '../api/types';
import { isCalendarTimeframe, type LiveTimeframe } from '../state/livePage';

export interface CandleTooltipModel {
  tsMs: number;
  dateLabel: string;        // "05/27" (분) / "2026/05/27" (D·W·M)
  timeLabel: string | null; // "09:01" (분) / null (D·W·M)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;           // vol_a + vol_b
  barOverBarWon: number | null;   // close − prev.close
  barOverBarPct: number | null;   // (close/prev.close − 1) × 100
  volumeRatioPct: number | null;  // (volume/prevVolume) × 100, prevVolume===0 → null
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ts_ms(실 Unix ms) → KST 라벨. LiveChartRoot timeFormatter 와 동일 규칙:
 *  calendar(D/W/M)는 09:00 KST 앵커라 시각이 오해를 주므로 날짜만. */
function kstLabels(
  tsMs: number,
  timeframe: LiveTimeframe,
): { dateLabel: string; timeLabel: string | null } {
  const d = new Date(tsMs + 9 * 3600_000);
  const md = `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  if (isCalendarTimeframe(timeframe)) {
    return { dateLabel: `${d.getUTCFullYear()}/${md}`, timeLabel: null };
  }
  return { dateLabel: md, timeLabel: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}

/**
 * 호버된 봉과 그 직전 봉만으로 툴팁 모델을 만든다. 순수 함수 — 차트/axis API 미접근.
 * `candles` 는 컴포넌트가 넘기는 "그려진(axis.contains 필터된, 타임프레임 집계된)"
 * 배열이라 `index-1` 이 직전 그려진 봉을 가리킨다 (봉대비, ADR-0059).
 */
export function buildCandleTooltip(
  candles: Candle[],
  index: number,
  timeframe: LiveTimeframe,
): CandleTooltipModel | null {
  if (index < 0 || index >= candles.length) return null;
  const c = candles[index];
  const volume = c.vol_a + c.vol_b;
  const { dateLabel, timeLabel } = kstLabels(c.ts_ms, timeframe);
  const prev = index > 0 ? candles[index - 1] : null;
  const prevVol = prev ? prev.vol_a + prev.vol_b : 0;
  return {
    tsMs: c.ts_ms,
    dateLabel,
    timeLabel,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume,
    barOverBarWon: prev ? c.close - prev.close : null,
    barOverBarPct: prev ? (c.close / prev.close - 1) * 100 : null,
    volumeRatioPct: prev && prevVol > 0 ? (volume / prevVol) * 100 : null,
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/live/candleTooltipModel.test.ts`
Expected: PASS (dateLabel 기대값이 어긋나면 실제 출력으로 한 번 맞춘 뒤 재실행).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/candleTooltipModel.ts frontend/src/live/candleTooltipModel.test.ts
git commit -m "feat(live): buildCandleTooltip 순수 모델 (봉대비, ADR-0059)"
```

---

## Task 2: 위치 계산 `placeTooltip` (flip/clamp)

**Files:**
- Modify: `frontend/src/live/candleTooltipModel.ts` (export 추가)
- Test: `frontend/src/live/candleTooltipModel.test.ts` (describe 추가)

- [ ] **Step 1: 실패하는 테스트 추가** (위 테스트 파일 끝에 append)

```ts
import { placeTooltip } from './candleTooltipModel';

describe('placeTooltip', () => {
  // 컨테이너 800×400, 툴팁 160×130, margin 12
  it('여유 있으면 커서 우하단(+14,+12)', () => {
    expect(placeTooltip(100, 50, 800, 400, 160, 130)).toEqual({ left: 114, top: 62 });
  });

  it('오른쪽 넘치면 커서 왼쪽으로 flip', () => {
    const p = placeTooltip(760, 50, 800, 400, 160, 130);
    expect(p.left).toBe(760 - 14 - 160); // 586
  });

  it('아래 넘치면 커서 위로 flip', () => {
    const p = placeTooltip(100, 380, 800, 400, 160, 130);
    expect(p.top).toBe(380 - 12 - 130); // 238
  });

  it('항상 컨테이너 안으로 clamp', () => {
    const p = placeTooltip(5, 5, 800, 400, 160, 130);
    expect(p.left).toBeGreaterThanOrEqual(12);
    expect(p.top).toBeGreaterThanOrEqual(12);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/candleTooltipModel.test.ts`
Expected: FAIL — `placeTooltip` is not exported.

- [ ] **Step 3: `placeTooltip` 구현** (`candleTooltipModel.ts` 끝에 append)

```ts
export interface TooltipPlacement {
  left: number;
  top: number;
}

/** 커서 기준 우하단 배치, 가장자리에서 flip, 컨테이너 안으로 clamp.
 *  px/py·containerW/H 는 chart.chartElement() 기준 좌표(= param.point 와 동일 공간). */
export function placeTooltip(
  px: number,
  py: number,
  containerW: number,
  containerH: number,
  tipW: number,
  tipH: number,
  margin = 12,
): TooltipPlacement {
  let left = px + 14;
  let top = py + 12;
  if (left + tipW + margin > containerW) left = px - 14 - tipW; // 우측 flip
  if (top + tipH + margin > containerH) top = py - 12 - tipH;   // 하단 flip
  left = Math.max(margin, Math.min(left, Math.max(margin, containerW - tipW - margin)));
  top = Math.max(margin, Math.min(top, Math.max(margin, containerH - tipH - margin)));
  return { left, top };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/live/candleTooltipModel.test.ts`
Expected: PASS (모델 + placeTooltip 전부).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/candleTooltipModel.ts frontend/src/live/candleTooltipModel.test.ts
git commit -m "feat(live): placeTooltip flip/clamp 위치 계산"
```

---

## Task 3: 설정 토글 `candleTooltipEnabled`

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts` (CHART_TOGGLES 엔트리 1개)
- Test: `frontend/src/state/chartPrefs.test.ts`

> 레지스트리가 단일 진실원천이라 **엔트리 하나만 수동 추가**하면 `ChartViewPrefs` 타입·`DEFAULT_PREFS`·`useChartPrefsStore`·`mergePrefs` 검증·`LiveSettingsModal` "차트" 행이 전부 자동 파생된다(`auctionWindowMask` 선례). 다른 파일 수정 불필요.

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/state/chartPrefs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_PREFS } from './chartPrefs';
import { mergePrefs } from './chartPrefsPersistence';

describe('candleTooltipEnabled 토글', () => {
  it('기본값 true', () => {
    expect(DEFAULT_PREFS.candleTooltipEnabled).toBe(true);
  });

  it('persist 된 false 를 보존', () => {
    expect(mergePrefs({ candleTooltipEnabled: false }).candleTooltipEnabled).toBe(false);
  });

  it('없으면 기본값(true) 으로 폴백', () => {
    expect(mergePrefs({}).candleTooltipEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/state/chartPrefs.test.ts`
Expected: FAIL — `DEFAULT_PREFS.candleTooltipEnabled` 가 `undefined` → `toBe(true)` 실패.

- [ ] **Step 3: CHART_TOGGLES 엔트리 추가**

`frontend/src/state/chartPrefs.ts` 의 `CHART_TOGGLES` 배열 안, `fillStrengthCumulative` 엔트리 **다음**(닫는 `] as const;` 직전)에 추가:

```ts
  {
    key: 'candleTooltipEnabled',
    label: '캔들 정보 툴팁',
    description: '캔들에 마우스를 올리면 시·고·저·종·직전대비·거래량·거래량비를 툴팁으로 표시합니다.',
    default: true,
  },
```

> `category` 필드 없음 → `categoryOf` 가 `'chart'` 로 기본 처리 → `LiveSettingsModal` "차트" 섹션에 자동 렌더(testId `settings-toggle-candleTooltipEnabled`).

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/state/chartPrefs.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/state/chartPrefs.ts frontend/src/state/chartPrefs.test.ts
git commit -m "feat(live): candleTooltipEnabled 설정 토글 (기본 ON)"
```

---

## Task 4: 오버레이 컴포넌트 `CandleTooltip`

**Files:**
- Create: `frontend/src/live/CandleTooltip.tsx`
- Test: `frontend/src/live/CandleTooltip.test.tsx`

- [ ] **Step 1: 실패하는 컴포넌트 테스트 작성**

`frontend/src/live/CandleTooltip.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import CandleTooltip from './CandleTooltip';
import { useChartPrefsStore } from '../state/chartPrefs';
import type { Candle } from '../api/types';

const origRAF = globalThis.requestAnimationFrame;
beforeEach(() => {
  // rAF 동기 실행
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as never;
  useChartPrefsStore.setState({ candleTooltipEnabled: true });
});
afterEach(() => { globalThis.requestAnimationFrame = origRAF; cleanup(); });

const C = (tsMs: number, o: number, h: number, l: number, c: number, va: number, vb = 0): Candle =>
  ({ ts_ms: tsMs, open: o, high: h, low: l, close: c, vol_a: va, vol_b: vb });

// identity axis: virtual ms == real ms, 전부 contained
const axis = {
  segments: [{}],
  toVirtual: (ms: number) => ms,
  toReal: (ms: number) => ms,
  contains: () => true,
} as never;

const bundle = {
  candles: [C(1_000_000, 100, 105, 99, 102, 10), C(1_060_000, 102, 108, 101, 107, 20)],
} as never;

function makeChart() {
  let handler: ((p: unknown) => void) | null = null;
  const chart = {
    subscribeCrosshairMove: (h: (p: unknown) => void) => { handler = h; },
    unsubscribeCrosshairMove: () => { handler = null; },
    panes: () => [{ getHeight: () => 400 }],
    chartElement: () => ({ clientWidth: 800, clientHeight: 400 }),
  } as never;
  return { chart, fire: (p: unknown) => act(() => { handler?.(p); }) };
}

function renderTip(chart: never) {
  return render(
    <CandleTooltip chart={chart} bundle={bundle} axis={axis} paneSeries={new Map() as never} timeframe="1m" />,
  );
}

describe('CandleTooltip', () => {
  it('토글 OFF 면 렌더 안 함', () => {
    useChartPrefsStore.setState({ candleTooltipEnabled: false });
    const { chart } = makeChart();
    renderTip(chart);
    expect(screen.queryByTestId('candle-tooltip')).toBeNull();
  });

  it('커서 이탈(point==null) 시 숨김', () => {
    const { chart, fire } = makeChart();
    renderTip(chart);
    fire({ point: null, time: 1060 });
    expect(screen.queryByTestId('candle-tooltip')).toBeNull();
  });

  it('캔들 페인 위에서 OHLC·직전대비·거래량비 표시', () => {
    const { chart, fire } = makeChart();
    renderTip(chart);
    // time = axis.toVirtual(1_060_000)/1000 = 1060 ; y=50 ∈ pane0
    fire({ point: { x: 100, y: 50 }, time: 1060 });
    const tip = screen.getByTestId('candle-tooltip');
    expect(tip).toHaveTextContent('107');   // 종가
    expect(tip).toHaveTextContent('+5');    // 직전대비 = 107-102
    expect(tip).toHaveTextContent('200%');  // 거래량비 = 20/10*100
  });

  it('첫 봉(직전 없음) → 직전대비·거래량비 —', () => {
    const { chart, fire } = makeChart();
    renderTip(chart);
    fire({ point: { x: 50, y: 50 }, time: 1000 }); // 첫 캔들 ts/1000
    const tip = screen.getByTestId('candle-tooltip');
    expect(tip).toHaveTextContent('—');
  });
});
```

> `paneSeries` 가 빈 Map 이면 `paneIdAtY` 의 fallback 이 `'candle'` 이라(인덱스 0 미등록 → fallback) 캔들 페인으로 판정된다 — 양성 케이스 테스트에 충분. 비-캔들 페인 숨김은 `paneIdAtY` 자체 테스트가 커버.

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/CandleTooltip.test.tsx`
Expected: FAIL — `CandleTooltip` 모듈 없음.

- [ ] **Step 3: 컴포넌트 구현**

`frontend/src/live/CandleTooltip.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { IChartApi, MouseEventParams } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { LiveTimeframe } from '../state/livePage';
import { useActivePrefs } from '../state/chartPrefs';
import { paneIdAtY, type PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import { priceDirClass } from '../ui/priceDir';
import { formatKoreanInt } from '../util/koreanNumber';
import { buildCandleTooltip, placeTooltip, type CandleTooltipModel } from './candleTooltipModel';

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
  timeframe: LiveTimeframe;
};

// 레전드 boxStyle 선례(불투명 표면 + DESIGN 토큰).
const boxStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 6,
  pointerEvents: 'none',
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2xs) var(--space-sm)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.5,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  minWidth: 150,
};
const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 16 };
const keyStyle: CSSProperties = { color: 'var(--fg-dimmer)' };
const valStyle: CSSProperties = { color: 'var(--fg)' };

const signed = (n: number) => (n >= 0 ? '+' : '') + formatKoreanInt(n);
const signedPct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={keyStyle}>{k}</span>
      {children}
    </div>
  );
}

export default function CandleTooltip({ chart, bundle, axis, paneSeries, timeframe }: Props) {
  const enabled = useActivePrefs((p) => p.candleTooltipEnabled);
  const tipRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ model: CandleTooltipModel; left: number; top: number } | null>(null);

  // 그려진 캔들 배열(projectCandle 와 동일 필터) + 가상시각(초)→index 맵.
  // 키는 projectCandle 의 candle.time = axis.toVirtual(ts_ms)/1000 과 정확히 동일(반올림 X).
  const { drawn, vsecToIndex } = useMemo(() => {
    const drawnArr = bundle.candles.filter((c) => axis.contains(c.ts_ms));
    const map = new Map<number, number>();
    drawnArr.forEach((c, i) => map.set(axis.toVirtual(c.ts_ms) / 1000, i));
    return { drawn: drawnArr, vsecToIndex: map };
  }, [bundle.candles, axis]);

  useEffect(() => {
    if (!enabled) { setState(null); return; }
    let pending: number | null = null;
    const handler = (param: MouseEventParams) => {
      if (param.point == null || typeof param.time !== 'number') {
        if (pending !== null) { cancelAnimationFrame(pending); pending = null; }
        setState(null);
        return;
      }
      const point = param.point;
      const time = param.time as number;
      if (pending !== null) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        pending = null;
        // 캔들 페인 한정.
        if (paneIdAtY(chart, paneSeries, point.y) !== 'candle') { setState(null); return; }
        const idx = vsecToIndex.get(time);
        if (idx === undefined) { setState(null); return; }
        const model = buildCandleTooltip(drawn, idx, timeframe);
        if (!model) { setState(null); return; }
        const el = chart.chartElement();
        const tip = tipRef.current;
        const place = placeTooltip(
          point.x, point.y,
          el?.clientWidth ?? 0, el?.clientHeight ?? 0,
          tip?.offsetWidth ?? 160, tip?.offsetHeight ?? 130,
        );
        setState({ model, left: place.left, top: place.top });
      });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      if (pending !== null) cancelAnimationFrame(pending);
      setState(null);
    };
  }, [chart, enabled, drawn, vsecToIndex, paneSeries, timeframe]);

  if (!enabled || !state) return null;
  const m = state.model;
  const bobNull = m.barOverBarWon == null || m.barOverBarPct == null;
  return (
    <div ref={tipRef} data-testid="candle-tooltip" style={{ ...boxStyle, left: state.left, top: state.top }}>
      <div style={{ ...rowStyle, color: 'var(--fg-dim)', marginBottom: 4 }}>
        <span>{m.dateLabel}{m.timeLabel ? ` ${m.timeLabel}` : ''}</span>
      </div>
      <Row k="시"><span style={valStyle}>{formatKoreanInt(m.open)}</span></Row>
      <Row k="고"><span style={valStyle}>{formatKoreanInt(m.high)}</span></Row>
      <Row k="저"><span style={valStyle}>{formatKoreanInt(m.low)}</span></Row>
      <Row k="종"><span style={valStyle}>{formatKoreanInt(m.close)}</span></Row>
      <Row k="직전대비">
        <span className={bobNull ? undefined : priceDirClass(m.barOverBarWon!)}>
          {bobNull ? '—' : `${signed(m.barOverBarWon!)}  ${signedPct(m.barOverBarPct!)}`}
        </span>
      </Row>
      <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
      <Row k="거래량"><span style={valStyle}>{formatKoreanInt(m.volume)}</span></Row>
      <Row k="거래량비">
        <span style={valStyle}>{m.volumeRatioPct == null ? '—' : `${Math.round(m.volumeRatioPct)}%`}</span>
      </Row>
    </div>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/live/CandleTooltip.test.tsx`
Expected: PASS (4 케이스).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/CandleTooltip.tsx frontend/src/live/CandleTooltip.test.tsx
git commit -m "feat(live): CandleTooltip 오버레이 (구독·페인 게이팅·위치)"
```

---

## Task 5: LiveChartRoot 에 마운트

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx` (import + 오버레이 그룹에 1줄)

- [ ] **Step 1: import 추가**

`frontend/src/live/LiveChartRoot.tsx` 상단 import 묶음에 추가(예: `PaneLegendOverlay` import 줄 근처):

```ts
import CandleTooltip from './CandleTooltip';
```

- [ ] **Step 2: 오버레이 그룹에 컴포넌트 추가**

`<PaneLegendOverlay chart={chart} timeframe={timeframe} paneSeries={paneSeries} />` 바로 **다음 줄**에 추가:

```tsx
          <CandleTooltip chart={chart} bundle={bundle} axis={axis} paneSeries={paneSeries} timeframe={timeframe} />
```

> 이 블록은 `{chart && bundle && axis.segments.length > 0 && (<> ... </>)}` 안이라 `chart`·`bundle`·`axis`·`paneSeries`·`timeframe` 전부 in-scope. 컴포넌트가 `position:absolute`·`pointer-events:none` 이고, 바깥 `live-chart-root` div 가 `position:relative` 라 좌표 기준이 맞다.

- [ ] **Step 3: 타입 + 회귀 테스트**

Run: `cd frontend && npx tsc -b`
Expected: PASS (타입 에러 0).

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx`
Expected: PASS (기존 LiveChartRoot 테스트 무회귀 — createChartEx 모킹이라 CandleTooltip 은 `chartElement`/`subscribeCrosshairMove` 모킹을 그대로 사용; 만약 모킹에 `chartElement` 가 없어 throw 하면 LiveChartRoot.test.tsx 의 createChartEx 모킹에 `chartElement: vi.fn(() => ({ clientWidth: 0, clientHeight: 0 }))` 한 줄 추가).

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/live/LiveChartRoot.tsx
git commit -m "feat(live): /live 차트에 CandleTooltip 마운트"
```

---

## Task 6: 최종 검증 + 스펙 plan-이월 정리

**Files:**
- Modify: `docs/superpowers/specs/2026-06-03-candle-hover-tooltip-design.md` (해소된 plan-이월 표시)

- [ ] **Step 1: 전체 테스트 + 타입 게이트**

Run: `cd frontend && npx vitest run src/live/candleTooltipModel.test.ts src/state/chartPrefs.test.ts src/live/CandleTooltip.test.tsx`
Expected: PASS (전부).

Run: `cd frontend && npx tsc -b`
Expected: PASS.

Run (변경 파일 한정 lint): `cd frontend && npx eslint src/live/candleTooltipModel.ts src/live/CandleTooltip.tsx src/state/chartPrefs.ts`
Expected: 0 errors (레포 전체 `eslint .` 는 기존 부채로 실패하므로 변경 파일만).

- [ ] **Step 2: 브라우저 도그푸드 (수동 확인)**

개발 서버가 떠 있다면(`http://localhost:5173/live`) 캔들에 호버해 툴팁이 (a) 캔들 페인에서만 뜨고, (b) OHLC·직전대비(상승 빨강/하락 파랑)·거래량·거래량비가 맞고, (c) 가장자리에서 flip 되며, (d) `LiveSettingsModal`의 "캔들 정보 툴팁" 토글로 on/off 되는지 확인.

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B console --errors   # JS 에러 없어야 함
```

- [ ] **Step 3: 스펙의 해소된 plan-이월 표시**

`docs/superpowers/specs/2026-06-03-candle-hover-tooltip-design.md` 의 "plan 이월" 항목 중 해소된 것을 갱신:
- `param.point` 좌표계 → **해소**: `chart.chartElement()` 기준 좌표 사용(param.point 와 동일 공간), 별도 `getBoundingClientRect` 오프셋 불필요.
- 가상시각→index 맵 → **해소**: `CandleTooltip` `useMemo` 로 구성(키 `axis.toVirtual(ts_ms)/1000`).

- [ ] **Step 4: 커밋**

```bash
git add docs/superpowers/specs/2026-06-03-candle-hover-tooltip-design.md
git commit -m "docs(live): 캔들 툴팁 구현 완료 — 해소된 plan-이월 정리"
```

---

## Self-Review 결과 (작성자 점검)

- **Spec coverage**: 배치(플로팅·캔들페인 한정 Task4) · 레이아웃 A(Task4 렌더) · 필드 OHLC/직전대비/거래량/거래량비(Task1·4) · 봉대비 단일규칙(Task1) · 타임프레임 전부(Task1 calendar 분기) · 토글 기본 ON(Task3) · 위치 flip/clamp(Task2) · 거동(라이브 형성봉=매 이동 재계산, muted=데이터 그대로, 독립 구독 Task4) — 전부 태스크 대응.
- **Placeholder**: 모든 스텝에 실제 코드·명령·기대출력 포함, "적절히 처리" 류 없음.
- **Type 일관성**: `CandleTooltipModel`(barOverBarWon/Pct, volumeRatioPct) Task1 정의 → Task4 소비 일치. `placeTooltip` 시그니처 Task2 정의 → Task4 호출 인자 수 일치. `candleTooltipEnabled` 키 Task3 → Task4 `useActivePrefs` 셀렉터 일치. `PaneSeriesMap`/`paneIdAtY` import 경로 확인됨.
