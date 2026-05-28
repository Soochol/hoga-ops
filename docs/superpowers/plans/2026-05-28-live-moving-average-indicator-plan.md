# /live Moving Average Indicator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

```yaml
scope: frontend
spec: docs/superpowers/specs/2026-05-28-live-moving-average-indicator-design.md
adr: docs/adr/0046-live-ma-fork-from-replay.md
```

**Goal:** /live 페이지에 가변 슬롯 이동평균선 지표를 추가한다 — 슬롯당 색상/선 굵기/소스/기간을 편집할 수 있고, 설정은 localStorage에 지속된다.

**Architecture:** /replay의 `MOVING_AVERAGE_SPEC`은 손대지 않는 fork 방식(ADR-0046). /live는 자체 `useLivePageStore.movingAverages` 슬라이스와 신규 `MovingAverageOverlay` 컴포넌트로 series 라이프사이클을 직접 관리한다. SMA 계산(`computeSMA`)만 /replay와 공유.

**Tech Stack:** TypeScript · React · Zustand · lightweight-charts (LineSeries) · Vitest + jsdom · Tailwind + CSS tokens.

---

## File Structure

**신규:**
- `frontend/src/state/liveIndicatorsPersistence.ts` — localStorage migration/validation
- `frontend/src/state/liveIndicatorsPersistence.test.ts`
- `frontend/src/live/indicators/MovingAverageOverlay.tsx` — chart series lifecycle
- `frontend/src/live/indicators/MovingAverageOverlay.test.tsx`
- `frontend/src/live/indicators/MASourceSelect.tsx`
- `frontend/src/live/indicators/MASourceSelect.test.tsx`
- `frontend/src/live/indicators/LineWidthSelect.tsx`
- `frontend/src/live/indicators/LineWidthSelect.test.tsx`
- `frontend/src/live/indicators/ColorSwatchButton.tsx`
- `frontend/src/live/indicators/ColorSwatchButton.test.tsx`
- `frontend/src/live/indicators/MovingAverageRow.tsx`
- `frontend/src/live/indicators/MovingAverageRow.test.tsx`
- `frontend/src/live/indicators/MovingAverageConfig.tsx`
- `frontend/src/live/indicators/MovingAverageConfig.test.tsx`
- `frontend/src/live/indicators/IndicatorPanel.tsx`
- `frontend/src/live/indicators/IndicatorPanel.test.tsx`

**수정:**
- `frontend/src/chart/projectors/movingAverage.ts` — `selectSource` + `MASource` export
- `frontend/src/chart/projectors/movingAverage.test.ts` — `selectSource` tests
- `frontend/src/state/livePage.ts` — `LiveMAConfig` 타입, `movingAverages` 슬라이스, actions
- `frontend/src/state/livePage.test.ts` — slice action tests
- `frontend/src/live/LiveToolbar.tsx` — "지표" 버튼
- `frontend/src/live/LivePage.tsx` — panel open state
- `frontend/src/live/LiveChartRoot.tsx` — `MovingAverageOverlay` mount
- `frontend/src/styles/tokens.css` — `--ma-6/7/8` 추가

---

## Phase A — 순수 코어 (state + helpers)

### Task 1: `selectSource` helper + `MASource` 타입

**Files:**
- Modify: `frontend/src/chart/projectors/movingAverage.ts`
- Modify: `frontend/src/chart/projectors/movingAverage.test.ts`

- [ ] **Step 1: Write failing tests**

`frontend/src/chart/projectors/movingAverage.test.ts` 상단(`describe('computeSMA'` 위)에 추가:

```ts
import { selectSource, type MASource } from './movingAverage';

describe('selectSource', () => {
  const c = { ts_ms: 1000, open: 10, high: 14, low: 6, close: 12, vol_a: 0, vol_b: 0 };

  it('returns close for source="close"', () => {
    expect(selectSource(c, 'close')).toBe(12);
  });
  it('returns open for source="open"', () => {
    expect(selectSource(c, 'open')).toBe(10);
  });
  it('returns high for source="high"', () => {
    expect(selectSource(c, 'high')).toBe(14);
  });
  it('returns low for source="low"', () => {
    expect(selectSource(c, 'low')).toBe(6);
  });
  it('returns (high+low)/2 for source="hl2"', () => {
    expect(selectSource(c, 'hl2')).toBe(10);
  });
  it('returns (high+low+close)/3 for source="hlc3"', () => {
    // (14 + 6 + 12) / 3 = 32 / 3
    expect(selectSource(c, 'hlc3')).toBeCloseTo(32 / 3, 10);
  });
  it('returns (open+high+low+close)/4 for source="ohlc4"', () => {
    // (10 + 14 + 6 + 12) / 4 = 10.5
    expect(selectSource(c, 'ohlc4')).toBe(10.5);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cd frontend && npx vitest run src/chart/projectors/movingAverage.test.ts`
Expected: 7 FAIL (`selectSource is not defined`)

- [ ] **Step 3: Implement `selectSource` + export type**

Append to `frontend/src/chart/projectors/movingAverage.ts` (after existing exports):

```ts
import type { Candle } from '../../api/types';

/** 이동평균을 계산할 때 캔들의 어느 가격을 입력 시계열로 쓸지. mockup의
 *  "소스" dropdown과 1:1 대응. close가 가장 흔하지만 분석가에 따라 시고저
 *  또는 가중 평균(HL2/HLC3/OHLC4)을 선호한다. */
export type MASource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';

export function selectSource(c: Candle, source: MASource): number {
  switch (source) {
    case 'close': return c.close;
    case 'open':  return c.open;
    case 'high':  return c.high;
    case 'low':   return c.low;
    case 'hl2':   return (c.high + c.low) / 2;
    case 'hlc3':  return (c.high + c.low + c.close) / 3;
    case 'ohlc4': return (c.open + c.high + c.low + c.close) / 4;
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd frontend && npx vitest run src/chart/projectors/movingAverage.test.ts`
Expected: all PASS, /replay MA tests still green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/projectors/movingAverage.ts frontend/src/chart/projectors/movingAverage.test.ts
git commit -m "feat(ma): selectSource helper + MASource type for /live MA pickers"
```

---

### Task 2: `LiveMAConfig` 타입 + 상수 + `DEFAULT_LIVE_MAS`

**Files:**
- Modify: `frontend/src/state/livePage.ts`
- Modify: `frontend/src/state/livePage.test.ts`

- [ ] **Step 1: Write failing test**

`frontend/src/state/livePage.test.ts` 끝에 추가:

```ts
import {
  DEFAULT_LIVE_MAS,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  type LiveMAConfig,
} from './livePage';

describe('LiveMAConfig constants', () => {
  it('exposes period bounds and slot limit', () => {
    expect(MA_PERIOD_MIN).toBe(2);
    expect(MA_PERIOD_MAX).toBe(400);
    expect(MA_SLOT_LIMIT).toBe(8);
  });

  it('DEFAULT_LIVE_MAS has 4 entries (5/20/60/120, all enabled, close, 1px)', () => {
    expect(DEFAULT_LIVE_MAS).toHaveLength(4);
    expect(DEFAULT_LIVE_MAS.map((m) => m.period)).toEqual([5, 20, 60, 120]);
    expect(DEFAULT_LIVE_MAS.every((m) => m.enabled)).toBe(true);
    expect(DEFAULT_LIVE_MAS.every((m) => m.source === 'close')).toBe(true);
    expect(DEFAULT_LIVE_MAS.every((m) => m.lineWidth === 1)).toBe(true);
  });

  it('DEFAULT_LIVE_MAS ids are unique', () => {
    const ids = DEFAULT_LIVE_MAS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('DEFAULT_LIVE_MAS is frozen (Object.freeze)', () => {
    expect(Object.isFrozen(DEFAULT_LIVE_MAS)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cd frontend && npx vitest run src/state/livePage.test.ts`
Expected: 4 FAIL (imports undefined).

- [ ] **Step 3: Add types + constants**

`frontend/src/state/livePage.ts` 상단(`const STORAGE_KEY` 위)에 추가:

```ts
import type { MASource } from '../chart/projectors/movingAverage';
export type { MASource };

/** /live의 이동평균선 한 슬롯. 가변 슬롯이므로 array index가 아니라
 *  안정 id로 식별한다 — mid-list 삭제가 다른 슬롯의 series identity를
 *  churn하지 않게 한다. ADR-0046 참조. */
export type LiveMAConfig = {
  id: string;
  enabled: boolean;
  period: number;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  source: MASource;
};

export const MA_PERIOD_MIN = 2;
export const MA_PERIOD_MAX = 400;
export const MA_SLOT_LIMIT = 8;

/** 색상 hex는 tokens.css의 --ma-N과 정확히 일치 (canvas는 CSS var를
 *  직접 받지 못함). --ma-2 (#3B82F6, blue)는 KRX --price-down (#2563EB,
 *  blue)과 색역이 가까워 기본 슬롯에서 의도적으로 스킵. spec §1 참조. */
export const DEFAULT_LIVE_MAS: readonly LiveMAConfig[] = Object.freeze([
  { id: 'ma-1', enabled: true, period: 5,   color: '#EC4899', lineWidth: 1, source: 'close' },
  { id: 'ma-2', enabled: true, period: 20,  color: '#F97316', lineWidth: 1, source: 'close' },
  { id: 'ma-3', enabled: true, period: 60,  color: '#22C55E', lineWidth: 1, source: 'close' },
  { id: 'ma-4', enabled: true, period: 120, color: '#F8FAFC', lineWidth: 1, source: 'close' },
]) as readonly LiveMAConfig[];
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd frontend && npx vitest run src/state/livePage.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/livePage.ts frontend/src/state/livePage.test.ts
git commit -m "feat(live): LiveMAConfig type + DEFAULT_LIVE_MAS constants"
```

---

### Task 3: localStorage validator `liveIndicatorsPersistence.ts`

**Files:**
- Create: `frontend/src/state/liveIndicatorsPersistence.ts`
- Create: `frontend/src/state/liveIndicatorsPersistence.test.ts`

- [ ] **Step 1: Write failing tests**

`frontend/src/state/liveIndicatorsPersistence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mergeLiveIndicatorPrefs, type PersistedIndicators } from './liveIndicatorsPersistence';
import { DEFAULT_LIVE_MAS } from './livePage';

describe('mergeLiveIndicatorPrefs', () => {
  it('returns defaults for undefined input', () => {
    expect(mergeLiveIndicatorPrefs(undefined)).toEqual({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
    });
  });

  it('returns defaults for non-object input', () => {
    expect(mergeLiveIndicatorPrefs('garbage' as unknown as PersistedIndicators).movingAverages)
      .toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('returns defaults when movingAverages is not an array', () => {
    expect(
      mergeLiveIndicatorPrefs({ movingAverages: 'oops' as unknown as never } as PersistedIndicators)
        .movingAverages,
    ).toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('returns defaults when all entries are invalid', () => {
    expect(
      mergeLiveIndicatorPrefs({ movingAverages: [{}, { id: 1 }] as unknown as never } as PersistedIndicators)
        .movingAverages,
    ).toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('keeps a single valid entry when others are invalid', () => {
    const valid = { id: 'k', enabled: true, period: 9, color: '#fff', lineWidth: 2, source: 'close' };
    const merged = mergeLiveIndicatorPrefs({
      movingAverages: [valid, { id: 'broken' } as unknown as never],
    } as PersistedIndicators);
    expect(merged.movingAverages).toEqual([valid]);
  });

  it('rejects out-of-range period entries', () => {
    const bad1 = { id: 'a', enabled: true, period: 1, color: '#fff', lineWidth: 1, source: 'close' };
    const bad2 = { id: 'b', enabled: true, period: 401, color: '#fff', lineWidth: 1, source: 'close' };
    expect(mergeLiveIndicatorPrefs({ movingAverages: [bad1, bad2] }).movingAverages)
      .toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('rejects unknown lineWidth values', () => {
    const bad = { id: 'a', enabled: true, period: 10, color: '#fff', lineWidth: 5, source: 'close' };
    expect(mergeLiveIndicatorPrefs({ movingAverages: [bad as unknown as never] }).movingAverages)
      .toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('rejects unknown source values', () => {
    const bad = { id: 'a', enabled: true, period: 10, color: '#fff', lineWidth: 1, source: 'volume' };
    expect(mergeLiveIndicatorPrefs({ movingAverages: [bad as unknown as never] }).movingAverages)
      .toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('enforces MA_SLOT_LIMIT — caps to 8 entries, drops the overflow', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `m-${i}`, enabled: true, period: 5 + i, color: '#fff', lineWidth: 1 as const, source: 'close' as const,
    }));
    const merged = mergeLiveIndicatorPrefs({ movingAverages: many });
    expect(merged.movingAverages).toHaveLength(8);
    expect(merged.movingAverages.map((m) => m.id)).toEqual(many.slice(0, 8).map((m) => m.id));
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts`
Expected: all FAIL (module missing).

- [ ] **Step 3: Implement validator**

Create `frontend/src/state/liveIndicatorsPersistence.ts`:

```ts
import {
  DEFAULT_LIVE_MAS,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  type LiveMAConfig,
} from './livePage';

const VALID_LINE_WIDTHS = new Set([1, 2, 3, 4]);
const VALID_SOURCES = new Set(['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4']);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export type PersistedIndicators = {
  movingAverages: LiveMAConfig[];
};

function isValidEntry(m: unknown): m is LiveMAConfig {
  if (!m || typeof m !== 'object') return false;
  const e = m as Record<string, unknown>;
  return (
    typeof e.id === 'string' && e.id.length > 0
    && typeof e.enabled === 'boolean'
    && typeof e.period === 'number'
    && Number.isFinite(e.period)
    && Number.isInteger(e.period)
    && e.period >= MA_PERIOD_MIN
    && e.period <= MA_PERIOD_MAX
    && typeof e.color === 'string' && HEX_COLOR.test(e.color)
    && typeof e.lineWidth === 'number' && VALID_LINE_WIDTHS.has(e.lineWidth)
    && typeof e.source === 'string' && VALID_SOURCES.has(e.source)
  );
}

/** Merge persisted state with defaults. If the input is structurally
 *  unrecoverable (missing/non-object/non-array MAs) return defaults.
 *  If a subset of entries is valid, keep those; if none are valid,
 *  fall back to defaults. Cap to MA_SLOT_LIMIT to prevent unbounded
 *  growth from a corrupted store. */
export function mergeLiveIndicatorPrefs(
  raw: PersistedIndicators | undefined | null | unknown,
): PersistedIndicators {
  const defaults = DEFAULT_LIVE_MAS.map((m) => ({ ...m }));
  if (!raw || typeof raw !== 'object') return { movingAverages: defaults };
  const arr = (raw as Record<string, unknown>).movingAverages;
  if (!Array.isArray(arr)) return { movingAverages: defaults };
  const kept = arr.filter(isValidEntry).slice(0, MA_SLOT_LIMIT) as LiveMAConfig[];
  if (kept.length === 0) return { movingAverages: defaults };
  return { movingAverages: kept };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/liveIndicatorsPersistence.test.ts
git commit -m "feat(live): mergeLiveIndicatorPrefs validator with shape/range/cap guards"
```

---

### Task 4: `useLivePageStore.movingAverages` 슬라이스 + actions

**Files:**
- Modify: `frontend/src/state/livePage.ts`
- Modify: `frontend/src/state/livePage.test.ts`

- [ ] **Step 1: Write failing tests**

`livePage.test.ts` 하단에 새 describe 추가:

```ts
import { MA_SLOT_LIMIT } from './livePage';

describe('useLivePageStore.movingAverages', () => {
  beforeEach(() => {
    localStorage.removeItem('live.indicators.v1');
    // Force re-hydrate by resetting state to DEFAULT_LIVE_MAS clone.
    useLivePageStore.setState({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
    });
  });

  it('starts with DEFAULT_LIVE_MAS clone (4 entries)', () => {
    expect(useLivePageStore.getState().movingAverages).toHaveLength(4);
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(5);
  });

  it('setMovingAverage patches one slot, preserves others by reference', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().setMovingAverage(before[1].id, { period: 25 });
    const after = useLivePageStore.getState().movingAverages;
    expect(after[1].period).toBe(25);
    expect(after[1].enabled).toBe(before[1].enabled);
    // Untouched slots are referentially equal (immutable patch).
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
  });

  it('setMovingAverage clamps period to [MA_PERIOD_MIN, MA_PERIOD_MAX]', () => {
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { period: 1 });
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(2);
    useLivePageStore.getState().setMovingAverage(id, { period: 1000 });
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(400);
  });

  it('setMovingAverage floors non-integer period', () => {
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { period: 3.7 });
    expect(useLivePageStore.getState().movingAverages[0].period).toBe(3);
  });

  it('setMovingAverage is no-op for unknown id', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().setMovingAverage('nope', { period: 99 });
    expect(useLivePageStore.getState().movingAverages).toBe(before);
  });

  it('addMovingAverage appends with new id, period = prev * 2 capped', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().addMovingAverage();
    const after = useLivePageStore.getState().movingAverages;
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1].period).toBe(Math.min(120 * 2, 400));
    // id is unique
    expect(new Set(after.map((m) => m.id)).size).toBe(after.length);
  });

  it('addMovingAverage is no-op when MA_SLOT_LIMIT reached', () => {
    // Fill to limit.
    while (useLivePageStore.getState().movingAverages.length < MA_SLOT_LIMIT) {
      useLivePageStore.getState().addMovingAverage();
    }
    const at_limit = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().addMovingAverage();
    expect(useLivePageStore.getState().movingAverages).toBe(at_limit);
  });

  it('removeMovingAverage drops the entry', () => {
    const before = useLivePageStore.getState().movingAverages;
    const targetId = before[1].id;
    useLivePageStore.getState().removeMovingAverage(targetId);
    const after = useLivePageStore.getState().movingAverages;
    expect(after).toHaveLength(before.length - 1);
    expect(after.find((m) => m.id === targetId)).toBeUndefined();
  });

  it('removeMovingAverage refuses to drop the last slot', () => {
    // Reduce to 1.
    const ids = useLivePageStore.getState().movingAverages.map((m) => m.id);
    for (const id of ids.slice(1)) {
      useLivePageStore.getState().removeMovingAverage(id);
    }
    expect(useLivePageStore.getState().movingAverages).toHaveLength(1);
    const single = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().removeMovingAverage(single[0].id);
    expect(useLivePageStore.getState().movingAverages).toBe(single);
  });

  it('removeMovingAverage is no-op for unknown id', () => {
    const before = useLivePageStore.getState().movingAverages;
    useLivePageStore.getState().removeMovingAverage('nope');
    expect(useLivePageStore.getState().movingAverages).toBe(before);
  });

  it('mutations persist to localStorage("live.indicators.v1")', () => {
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { period: 7 });
    const raw = localStorage.getItem('live.indicators.v1');
    expect(raw).toContain('"period":7');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cd frontend && npx vitest run src/state/livePage.test.ts`
Expected: action tests FAIL.

- [ ] **Step 3: Implement slice + actions**

`frontend/src/state/livePage.ts` 변경:

(3-1) 별도 LS 키 추가 (`const STORAGE_KEY = 'live.page.v1';` 아래):

```ts
const INDICATORS_STORAGE_KEY = 'live.indicators.v1';
```

(3-2) `type Persisted` 옆에 새 타입:

```ts
type PersistedIndicators = {
  movingAverages: LiveMAConfig[];
};
```

(3-3) `type Store = Persisted & { ... }` 안의 actions에 추가:

```ts
type Store = Persisted & PersistedIndicators & {
  // 기존 actions ...
  setMovingAverage: (id: string, patch: Partial<LiveMAConfig>) => void;
  addMovingAverage: () => void;
  removeMovingAverage: (id: string) => void;
};
```

(3-4) helpers 추가 (`readStorage` 아래):

```ts
import {
  mergeLiveIndicatorPrefs,
  type PersistedIndicators as MergedIndicators,
} from './liveIndicatorsPersistence';

function persistIndicators(state: PersistedIndicators): void {
  try {
    localStorage.setItem(INDICATORS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable — silent fallback
  }
}

function readIndicatorsStorage(): MergedIndicators {
  try {
    const raw = localStorage.getItem(INDICATORS_STORAGE_KEY);
    return mergeLiveIndicatorPrefs(raw ? JSON.parse(raw) : undefined);
  } catch {
    return mergeLiveIndicatorPrefs(undefined);
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function nextSlotId(existing: readonly LiveMAConfig[]): string {
  const used = new Set(existing.map((m) => m.id));
  // Try fast path: ma-N for N up to MA_SLOT_LIMIT * 2.
  for (let i = 1; i <= MA_SLOT_LIMIT * 2; i++) {
    const id = `ma-${i}`;
    if (!used.has(id)) return id;
  }
  // Fallback (should never hit given MA_SLOT_LIMIT cap).
  return `ma-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

/** Palette 8색 hex 순서 — tokens.css의 --ma-1..--ma-8과 매칭. canvas는 CSS
 *  var를 직접 받지 못해 hex로 정적 deflate. ColorSwatchButton이 같은
 *  배열을 import하여 swatch grid를 표시하므로 single source. */
export const MA_PALETTE: readonly string[] = [
  '#EC4899', '#3B82F6', '#F97316', '#22C55E',
  '#F8FAFC', '#06B6D4', '#EAB308', '#94A3B8',
];

function nextSlotColor(existing: readonly LiveMAConfig[]): string {
  const used = new Set(existing.map((m) => m.color.toLowerCase()));
  const free = MA_PALETTE.find((c) => !used.has(c.toLowerCase()));
  return free ?? MA_PALETTE[existing.length % MA_PALETTE.length];
}
```

(3-5) `DEFAULTS` 변경 + actions 구현:

`DEFAULTS` 그대로 유지하고, store factory의 spread를 확장:

```ts
export const useLivePageStore = create<Store>((set, get) => ({
  ...DEFAULTS,
  ...readStorage(),
  ...readIndicatorsStorage(),

  // 기존 actions ...

  setMovingAverage: (id, patch) => {
    const current = get().movingAverages;
    const idx = current.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const cur = current[idx];
    const next: LiveMAConfig = { ...cur, ...patch };
    if (patch.period !== undefined) {
      const p = Number(patch.period);
      if (!Number.isFinite(p)) return;
      next.period = clamp(Math.floor(p), MA_PERIOD_MIN, MA_PERIOD_MAX);
    }
    const nextArr = current.slice();
    nextArr[idx] = next;
    set({ movingAverages: nextArr });
    persistIndicators({ movingAverages: nextArr });
  },

  addMovingAverage: () => {
    const current = get().movingAverages;
    if (current.length >= MA_SLOT_LIMIT) return;
    const last = current[current.length - 1];
    const period = last ? clamp(last.period * 2, MA_PERIOD_MIN, MA_PERIOD_MAX) : 20;
    const next: LiveMAConfig = {
      id: nextSlotId(current),
      enabled: true,
      period,
      color: nextSlotColor(current),
      lineWidth: 1,
      source: 'close',
    };
    const nextArr = [...current, next];
    set({ movingAverages: nextArr });
    persistIndicators({ movingAverages: nextArr });
  },

  removeMovingAverage: (id) => {
    const current = get().movingAverages;
    if (current.length <= 1) return;
    const nextArr = current.filter((m) => m.id !== id);
    if (nextArr.length === current.length) return; // unknown id
    set({ movingAverages: nextArr });
    persistIndicators({ movingAverages: nextArr });
  },
}));
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd frontend && npx vitest run src/state/livePage.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/livePage.ts frontend/src/state/livePage.test.ts
git commit -m "feat(live): movingAverages slice + add/remove/set actions + persistence"
```

---

### Task 5: `--ma-6/7/8` palette 토큰

**Files:**
- Modify: `frontend/src/styles/tokens.css`

- [ ] **Step 1: Modify tokens.css**

`frontend/src/styles/tokens.css`에서 `--ma-5: #F8FAFC;` 다음 줄에 추가:

```css
  --ma-6: #06B6D4; /* cyan — extension slot 6 */
  --ma-7: #EAB308; /* yellow — extension slot 7 */
  --ma-8: #94A3B8; /* slate — extension slot 8 */
```

- [ ] **Step 2: Verify build still passes**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/styles/tokens.css
git commit -m "feat(tokens): --ma-6/7/8 palette for variable MA slots"
```

---

## Phase B — Chart overlay

### Task 6: `MovingAverageOverlay` 컴포넌트

**Files:**
- Create: `frontend/src/live/indicators/MovingAverageOverlay.tsx`
- Create: `frontend/src/live/indicators/MovingAverageOverlay.test.tsx`

- [ ] **Step 1: Write failing tests**

`frontend/src/live/indicators/MovingAverageOverlay.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useLivePageStore, DEFAULT_LIVE_MAS } from '../../state/livePage';
import MovingAverageOverlay from './MovingAverageOverlay';

// Minimal IChartApi mock — captures addSeries / removeSeries / applyOptions
// / setData calls so we can assert on series lifecycle without booting
// lightweight-charts.
function makeChartMock() {
  const seriesById = new Map<string, ReturnType<typeof makeSeriesMock>>();
  let seriesCounter = 0;
  function makeSeriesMock() {
    return {
      applyOptions: vi.fn(),
      setData: vi.fn(),
      _internalId: ++seriesCounter,
    };
  }
  const addSeries = vi.fn((_type: unknown, options: { color: string }) => {
    const s = makeSeriesMock();
    seriesById.set(String(s._internalId), s);
    (s as unknown as { _color: string })._color = options.color;
    return s;
  });
  const removeSeries = vi.fn((s: ReturnType<typeof makeSeriesMock>) => {
    seriesById.delete(String(s._internalId));
  });
  return { chart: { addSeries, removeSeries } as unknown, addSeries, removeSeries, seriesById };
}

// 5 trivial in-session candles, ts_ms ascending.
const candles = [1, 2, 3, 4, 5].map((i) => ({
  ts_ms: i * 1000, open: i, close: i, high: i, low: i, vol_a: 0, vol_b: 0,
}));
const bundle = { candles } as never;
// axis.contains true for all (in-session); toVirtual identity.
const axis = { contains: () => true, toVirtual: (m: number) => m } as never;

describe('MovingAverageOverlay', () => {
  beforeEach(() => {
    cleanup();
    useLivePageStore.setState({ movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })) });
  });

  it('mounts one LineSeries per configured slot', () => {
    const m = makeChartMock();
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    expect(m.addSeries).toHaveBeenCalledTimes(DEFAULT_LIVE_MAS.length);
  });

  it('calls setData on each mounted series', () => {
    const m = makeChartMock();
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    for (const [, s] of m.seriesById) {
      expect(s.setData).toHaveBeenCalled();
    }
  });

  it('addMovingAverage triggers one addSeries (no churn on existing slots)', () => {
    const m = makeChartMock();
    const { rerender } = render(
      <MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />,
    );
    const callsBefore = m.addSeries.mock.calls.length;
    useLivePageStore.getState().addMovingAverage();
    rerender(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    expect(m.addSeries.mock.calls.length).toBe(callsBefore + 1);
    expect(m.removeSeries).not.toHaveBeenCalled();
  });

  it('setMovingAverage(period) does NOT call addSeries/removeSeries', () => {
    const m = makeChartMock();
    const { rerender } = render(
      <MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />,
    );
    const id = useLivePageStore.getState().movingAverages[0].id;
    m.addSeries.mockClear();
    m.removeSeries.mockClear();
    useLivePageStore.getState().setMovingAverage(id, { period: 7 });
    rerender(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    expect(m.addSeries).not.toHaveBeenCalled();
    expect(m.removeSeries).not.toHaveBeenCalled();
  });

  it('setMovingAverage(color) calls applyOptions with new color', () => {
    const m = makeChartMock();
    const { rerender } = render(
      <MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />,
    );
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { color: '#06B6D4' });
    rerender(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    const lastApply = Array.from(m.seriesById.values()).flatMap(
      (s) => s.applyOptions.mock.calls,
    );
    expect(lastApply.some((c) => (c[0] as { color: string }).color === '#06B6D4')).toBe(true);
  });

  it('removeMovingAverage calls removeSeries once', () => {
    const m = makeChartMock();
    const { rerender } = render(
      <MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />,
    );
    const id = useLivePageStore.getState().movingAverages[1].id;
    useLivePageStore.getState().removeMovingAverage(id);
    rerender(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    expect(m.removeSeries).toHaveBeenCalledTimes(1);
  });

  it('disabled slot setData receives empty array', () => {
    const m = makeChartMock();
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { enabled: false });
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    // First-added series corresponds to the first config (id matched).
    const first = m.addSeries.mock.results[0].value as ReturnType<typeof Object> & { setData: ReturnType<typeof vi.fn> };
    const lastSetData = (first.setData as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(lastSetData?.[0]).toEqual([]);
  });

  it('out-of-session candles are excluded from SMA input', () => {
    const m = makeChartMock();
    // Mark middle candle as out-of-session.
    const customAxis = {
      contains: (ms: number) => ms !== 3000,
      toVirtual: (ms: number) => ms,
    } as never;
    // Force a single slot with period=2 for an easy assertion.
    useLivePageStore.setState({
      movingAverages: [{
        id: 's', enabled: true, period: 2, color: '#fff', lineWidth: 1, source: 'close',
      }],
    });
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={customAxis} />);
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    const data = first.setData.mock.calls.at(-1)?.[0] as Array<{ time: number; value?: number }>;
    // In-session: [1, 2, 4, 5]; SMA(2) = [null, 1.5, 3, 4.5]
    expect(data).toHaveLength(4);
    expect(data[0]).toEqual({ time: 1000 });
    expect(data[1]).toEqual({ time: 2000, value: 1.5 });
    expect(data[2]).toEqual({ time: 4000, value: 3 });
    expect(data[3]).toEqual({ time: 5000, value: 4.5 });
  });

  it('unmount removes all series', () => {
    const m = makeChartMock();
    const { unmount } = render(
      <MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />,
    );
    const addedCount = m.addSeries.mock.calls.length;
    unmount();
    expect(m.removeSeries).toHaveBeenCalledTimes(addedCount);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cd frontend && npx vitest run src/live/indicators/MovingAverageOverlay.test.tsx`
Expected: all FAIL (module missing).

- [ ] **Step 3: Implement `MovingAverageOverlay`**

Create `frontend/src/live/indicators/MovingAverageOverlay.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { LineSeries, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { useLivePageStore } from '../../state/livePage';
import { computeSMA, selectSource } from '../../chart/projectors/movingAverage';

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
};

type LineApi = ISeriesApi<'Line'>;

/** /live의 이동평균선 오버레이. /replay의 정적 5슬롯 MOVING_AVERAGE_SPEC과
 *  분리된 가변 슬롯 모델 (ADR-0046). 슬롯 id 기준 series Map을 유지하며
 *  configs 변경 시 add/remove/applyOptions를 reconcile한다. period/source
 *  같은 데이터 patch는 setData만 호출 — series identity churn 없음. */
export default function MovingAverageOverlay({ chart, bundle, axis }: Props) {
  const configs = useLivePageStore((s) => s.movingAverages);
  const seriesByIdRef = useRef<Map<string, LineApi>>(new Map());

  // Reconcile series ↔ configs by id.
  useEffect(() => {
    const map = seriesByIdRef.current;
    const currentIds = new Set(configs.map((c) => c.id));

    // Remove gone slots.
    for (const [id, s] of Array.from(map.entries())) {
      if (!currentIds.has(id)) {
        try { chart.removeSeries(s); } catch { /* chart torn down */ }
        map.delete(id);
      }
    }

    // Add or update.
    for (const cfg of configs) {
      const existing = map.get(cfg.id);
      if (!existing) {
        try {
          const s = chart.addSeries(LineSeries, {
            color: cfg.color,
            lineWidth: cfg.lineWidth,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          }, 0); // paneIndex 0 — candle pane overlay
          map.set(cfg.id, s);
        } catch { /* chart torn down */ }
      } else {
        existing.applyOptions({ color: cfg.color, lineWidth: cfg.lineWidth });
      }
    }
  }, [chart, configs]);

  // Unmount cleanup — remove all series.
  useEffect(() => {
    return () => {
      const map = seriesByIdRef.current;
      for (const [, s] of map) {
        try { chart.removeSeries(s); } catch { /* chart torn down */ }
      }
      map.clear();
    };
  }, [chart]);

  // Push projected SMA into each series.
  useEffect(() => {
    const map = seriesByIdRef.current;
    const inSession = bundle.candles.filter((c) => axis.contains(c.ts_ms));
    for (const cfg of configs) {
      const s = map.get(cfg.id);
      if (!s) continue;
      if (!cfg.enabled) {
        s.setData([]);
        continue;
      }
      const values = inSession.map((c) => selectSource(c, cfg.source));
      const sma = computeSMA(values, cfg.period);
      const data = inSession.map((c, j) => {
        const time = (axis.toVirtual(c.ts_ms) / 1000) as Time;
        const v = sma[j];
        return v === null ? { time } : { time, value: v };
      });
      s.setData(data as never);
    }
  }, [bundle, axis, configs]);

  return null;
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd frontend && npx vitest run src/live/indicators/MovingAverageOverlay.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/MovingAverageOverlay.tsx frontend/src/live/indicators/MovingAverageOverlay.test.tsx
git commit -m "feat(live): MovingAverageOverlay with id-keyed series reconciliation"
```

---

## Phase C — UI components

### Task 7: `MASourceSelect`

**Files:**
- Create: `frontend/src/live/indicators/MASourceSelect.tsx`
- Create: `frontend/src/live/indicators/MASourceSelect.test.tsx`

- [ ] **Step 1: Write failing tests**

`frontend/src/live/indicators/MASourceSelect.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MASourceSelect from './MASourceSelect';

describe('MASourceSelect', () => {
  it('renders all 7 source options', () => {
    render(<MASourceSelect value="close" onChange={() => {}} />);
    const opts = screen.getAllByRole('option');
    expect(opts.map((o) => o.getAttribute('value'))).toEqual([
      'close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4',
    ]);
  });

  it('displays current value as selected', () => {
    render(<MASourceSelect value="hl2" onChange={() => {}} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('hl2');
  });

  it('calls onChange when user picks a different option', () => {
    const onChange = vi.fn();
    render(<MASourceSelect value="close" onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'high' } });
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('shows Korean label for close option', () => {
    render(<MASourceSelect value="close" onChange={() => {}} />);
    expect(screen.getByText('종가')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cd frontend && npx vitest run src/live/indicators/MASourceSelect.test.tsx`

- [ ] **Step 3: Implement**

```tsx
import type { MASource } from '../../chart/projectors/movingAverage';

type Props = {
  value: MASource;
  onChange: (next: MASource) => void;
  'aria-label'?: string;
};

const OPTIONS: ReadonlyArray<[MASource, string]> = [
  ['close', '종가'],
  ['open',  '시가'],
  ['high',  '고가'],
  ['low',   '저가'],
  ['hl2',   'HL2'],
  ['hlc3',  'HLC3'],
  ['ohlc4', 'OHLC4'],
];

export default function MASourceSelect({ value, onChange, ...rest }: Props) {
  return (
    <select
      role="combobox"
      aria-label={rest['aria-label'] ?? 'MA 소스'}
      value={value}
      onChange={(e) => onChange(e.target.value as MASource)}
      className="text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1"
    >
      {OPTIONS.map(([v, label]) => (
        <option key={v} value={v}>{label}</option>
      ))}
    </select>
  );
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/MASourceSelect.tsx frontend/src/live/indicators/MASourceSelect.test.tsx
git commit -m "feat(live): MASourceSelect dropdown for 7 source kinds"
```

---

### Task 8: `LineWidthSelect`

**Files:**
- Create: `frontend/src/live/indicators/LineWidthSelect.tsx`
- Create: `frontend/src/live/indicators/LineWidthSelect.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LineWidthSelect from './LineWidthSelect';

describe('LineWidthSelect', () => {
  it('renders 4 width options', () => {
    render(<LineWidthSelect value={1} onChange={() => {}} />);
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(4);
    expect(opts.map((o) => o.getAttribute('value'))).toEqual(['1', '2', '3', '4']);
  });

  it('displays current width', () => {
    render(<LineWidthSelect value={3} onChange={() => {}} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('3');
  });

  it('emits numeric value to onChange', () => {
    const onChange = vi.fn();
    render(<LineWidthSelect value={1} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith(2);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement**

```tsx
type Width = 1 | 2 | 3 | 4;

type Props = {
  value: Width;
  onChange: (next: Width) => void;
};

export default function LineWidthSelect({ value, onChange }: Props) {
  return (
    <select
      role="combobox"
      aria-label="MA 선 굵기"
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value) as Width)}
      className="text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1"
    >
      {[1, 2, 3, 4].map((w) => (
        <option key={w} value={String(w)}>{`${w}px`}</option>
      ))}
    </select>
  );
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/LineWidthSelect.tsx frontend/src/live/indicators/LineWidthSelect.test.tsx
git commit -m "feat(live): LineWidthSelect (1/2/3/4 px)"
```

---

### Task 9: `ColorSwatchButton`

**Files:**
- Create: `frontend/src/live/indicators/ColorSwatchButton.tsx`
- Create: `frontend/src/live/indicators/ColorSwatchButton.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ColorSwatchButton, { MA_PALETTE } from './ColorSwatchButton';

describe('ColorSwatchButton', () => {
  it('renders a button showing the current color', () => {
    render(<ColorSwatchButton value="#EC4899" onChange={() => {}} />);
    const btn = screen.getByRole('button', { name: 'MA 색상 선택' });
    expect(btn.style.backgroundColor).toMatch(/236.*72.*153|#ec4899/i);
  });

  it('opens palette popover on click', () => {
    render(<ColorSwatchButton value="#EC4899" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 색상 선택' }));
    // After open, palette options appear.
    const palette = screen.getAllByRole('button', { name: /MA 색상 후보/ });
    expect(palette).toHaveLength(MA_PALETTE.length);
  });

  it('emits selected hex via onChange and closes popover', () => {
    const onChange = vi.fn();
    render(<ColorSwatchButton value="#EC4899" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'MA 색상 선택' }));
    const options = screen.getAllByRole('button', { name: /MA 색상 후보/ });
    fireEvent.click(options[2]);
    expect(onChange).toHaveBeenCalledWith(MA_PALETTE[2]);
    // After selection, palette options should no longer be in the document.
    expect(screen.queryAllByRole('button', { name: /MA 색상 후보/ })).toHaveLength(0);
  });

  it('exports an 8-color MA_PALETTE matching tokens.css', () => {
    expect(MA_PALETTE).toHaveLength(8);
    expect(MA_PALETTE[0]).toBe('#EC4899');
    expect(MA_PALETTE[7]).toBe('#94A3B8');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useRef, useState } from 'react';
import { MA_PALETTE } from '../../state/livePage';

// Single-source MA_PALETTE은 state/livePage에 산다 (nextSlotColor가 사용).
// Tests/colocated UI는 이곳에서 re-export 받아 쓸 수 있다.
export { MA_PALETTE };

type Props = {
  value: string;
  onChange: (next: string) => void;
};

export default function ColorSwatchButton({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        aria-label="MA 색상 선택"
        onClick={() => setOpen((o) => !o)}
        style={{ backgroundColor: value }}
        className="w-5 h-5 rounded-[3px] border border-border"
      />
      {open && (
        <div
          role="dialog"
          aria-label="MA 색상 팔레트"
          className="absolute top-7 left-0 grid grid-cols-4 gap-1 p-1.5 bg-bg-card border border-border-strong rounded shadow-lg z-50"
        >
          {MA_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`MA 색상 후보 ${c}`}
              aria-pressed={c.toLowerCase() === value.toLowerCase()}
              onClick={() => { onChange(c); setOpen(false); }}
              style={{ backgroundColor: c }}
              className="w-5 h-5 rounded-[3px] border border-border hover:scale-110 transition-transform"
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/ColorSwatchButton.tsx frontend/src/live/indicators/ColorSwatchButton.test.tsx
git commit -m "feat(live): ColorSwatchButton with 8-color palette popover"
```

---

### Task 10: `MovingAverageRow`

**Files:**
- Create: `frontend/src/live/indicators/MovingAverageRow.tsx`
- Create: `frontend/src/live/indicators/MovingAverageRow.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MovingAverageRow from './MovingAverageRow';
import type { LiveMAConfig } from '../../state/livePage';

const cfg: LiveMAConfig = {
  id: 'ma-1', enabled: true, period: 20, color: '#EC4899', lineWidth: 1, source: 'close',
};

describe('MovingAverageRow', () => {
  it('renders the slot label and current period', () => {
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={() => {}} onRemove={() => {}} />);
    expect(screen.getByText('기간1')).toBeTruthy();
    const periodInput = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(periodInput.value).toBe('20');
  });

  it('toggle button reflects enabled state', () => {
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={() => {}} onRemove={() => {}} />);
    const toggle = screen.getByRole('switch') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('toggle click emits onChange({enabled: false})', () => {
    const onChange = vi.fn();
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={onChange} onRemove={() => {}} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith({ enabled: false });
  });

  it('period commit on blur emits onChange({period: N})', () => {
    const onChange = vi.fn();
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={onChange} onRemove={() => {}} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ period: 50 });
  });

  it('period commit on Enter emits onChange', () => {
    const onChange = vi.fn();
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={onChange} onRemove={() => {}} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ period: 7 });
  });

  it('invalid period commit reverts the input', () => {
    const onChange = vi.fn();
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={onChange} onRemove={() => {}} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('20');
  });

  it('remove button hidden when canRemove=false', () => {
    render(<MovingAverageRow index={0} config={cfg} canRemove={false} onChange={() => {}} onRemove={() => {}} />);
    expect(screen.queryByRole('button', { name: '슬롯 삭제' })).toBeNull();
  });

  it('remove button calls onRemove when canRemove=true', () => {
    const onRemove = vi.fn();
    render(<MovingAverageRow index={0} config={cfg} canRemove={true} onChange={() => {}} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: '슬롯 삭제' }));
    expect(onRemove).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useState } from 'react';
import type { LiveMAConfig } from '../../state/livePage';
import { MA_PERIOD_MIN, MA_PERIOD_MAX } from '../../state/livePage';
import ColorSwatchButton from './ColorSwatchButton';
import LineWidthSelect from './LineWidthSelect';
import MASourceSelect from './MASourceSelect';

type Props = {
  index: number;
  config: LiveMAConfig;
  canRemove: boolean;
  onChange: (patch: Partial<LiveMAConfig>) => void;
  onRemove: () => void;
};

export default function MovingAverageRow({ index, config, canRemove, onChange, onRemove }: Props) {
  const [draft, setDraft] = useState<string>(String(config.period));
  useEffect(() => { setDraft(String(config.period)); }, [config.period]);

  const commit = () => {
    const t = draft.trim();
    const n = Number(t);
    if (
      t !== '' && Number.isFinite(n) && Number.isInteger(n)
      && n >= MA_PERIOD_MIN && n <= MA_PERIOD_MAX && n !== config.period
    ) {
      onChange({ period: n });
    } else {
      setDraft(String(config.period));
    }
  };

  return (
    <div className="grid grid-cols-[56px_36px_1fr_1fr_72px_24px] items-center gap-2 py-1.5">
      <div className="text-sm text-fg tabular-nums">{`기간${index + 1}`}</div>
      <button
        type="button"
        role="switch"
        aria-checked={config.enabled}
        aria-label={`기간${index + 1} 토글`}
        onClick={() => onChange({ enabled: !config.enabled })}
        className={
          config.enabled
            ? 'relative inline-flex h-5 w-9 items-center rounded-full bg-accent transition-colors'
            : 'relative inline-flex h-5 w-9 items-center rounded-full bg-bg-input-hover transition-colors'
        }
      >
        <span
          className={
            config.enabled
              ? 'inline-block h-4 w-4 rounded-full bg-accent-fg translate-x-[18px] transition-transform'
              : 'inline-block h-4 w-4 rounded-full bg-fg-dim translate-x-[2px] transition-transform'
          }
        />
      </button>
      <div className="flex items-center gap-2">
        <ColorSwatchButton value={config.color} onChange={(c) => onChange({ color: c })} />
        <LineWidthSelect value={config.lineWidth} onChange={(w) => onChange({ lineWidth: w })} />
      </div>
      <MASourceSelect value={config.source} onChange={(s) => onChange({ source: s })} />
      <input
        type="number"
        role="spinbutton"
        min={MA_PERIOD_MIN}
        max={MA_PERIOD_MAX}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        aria-label={`기간${index + 1} 길이`}
        className="w-[72px] text-right text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1 tabular-nums"
      />
      {canRemove ? (
        <button
          type="button"
          aria-label="슬롯 삭제"
          onClick={onRemove}
          className="text-fg-dim hover:text-fg text-base leading-none"
        >
          ✕
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/MovingAverageRow.tsx frontend/src/live/indicators/MovingAverageRow.test.tsx
git commit -m "feat(live): MovingAverageRow with toggle/color/width/source/period/remove"
```

---

### Task 11: `MovingAverageConfig`

**Files:**
- Create: `frontend/src/live/indicators/MovingAverageConfig.tsx`
- Create: `frontend/src/live/indicators/MovingAverageConfig.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MovingAverageConfig from './MovingAverageConfig';
import { useLivePageStore, DEFAULT_LIVE_MAS, MA_SLOT_LIMIT } from '../../state/livePage';

describe('MovingAverageConfig', () => {
  beforeEach(() => {
    useLivePageStore.setState({ movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })) });
  });

  it('renders one row per slot', () => {
    render(<MovingAverageConfig />);
    expect(screen.getAllByRole('switch')).toHaveLength(DEFAULT_LIVE_MAS.length);
  });

  it('"기간 추가" button appends a slot', () => {
    render(<MovingAverageConfig />);
    const addBtn = screen.getByRole('button', { name: '기간 추가' });
    fireEvent.click(addBtn);
    expect(useLivePageStore.getState().movingAverages).toHaveLength(DEFAULT_LIVE_MAS.length + 1);
  });

  it('"기간 추가" is disabled when MA_SLOT_LIMIT reached', () => {
    while (useLivePageStore.getState().movingAverages.length < MA_SLOT_LIMIT) {
      useLivePageStore.getState().addMovingAverage();
    }
    render(<MovingAverageConfig />);
    const addBtn = screen.getByRole('button', { name: '기간 추가' }) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });

  it('remove button hidden when only one slot remains', () => {
    // Reduce to 1.
    const ids = useLivePageStore.getState().movingAverages.map((m) => m.id);
    for (const id of ids.slice(1)) useLivePageStore.getState().removeMovingAverage(id);
    render(<MovingAverageConfig />);
    expect(screen.queryByRole('button', { name: '슬롯 삭제' })).toBeNull();
  });

  it('header shows 지표명 + tooltip-helper', () => {
    render(<MovingAverageConfig />);
    expect(screen.getByText('이동평균선')).toBeTruthy();
    expect(screen.getByText(/지난 n일 동안 주가 평균값/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement**

```tsx
import { useLivePageStore, MA_SLOT_LIMIT } from '../../state/livePage';
import MovingAverageRow from './MovingAverageRow';

export default function MovingAverageConfig() {
  const configs = useLivePageStore((s) => s.movingAverages);
  const setMA = useLivePageStore((s) => s.setMovingAverage);
  const addMA = useLivePageStore((s) => s.addMovingAverage);
  const removeMA = useLivePageStore((s) => s.removeMovingAverage);
  const atLimit = configs.length >= MA_SLOT_LIMIT;
  const canRemove = configs.length > 1;

  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        이동평균선 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        지난 n일 동안 주가 평균값을 이은 선
      </p>
      <div>
        {configs.map((cfg, i) => (
          <MovingAverageRow
            key={cfg.id}
            index={i}
            config={cfg}
            canRemove={canRemove}
            onChange={(patch) => setMA(cfg.id, patch)}
            onRemove={() => removeMA(cfg.id)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={addMA}
        disabled={atLimit}
        className="mt-3 px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded disabled:opacity-50 disabled:cursor-not-allowed"
      >
        ⊕ 기간 추가
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/MovingAverageConfig.tsx frontend/src/live/indicators/MovingAverageConfig.test.tsx
git commit -m "feat(live): MovingAverageConfig — slot list + add button"
```

---

### Task 12: `IndicatorPanel` modal

**Files:**
- Create: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Create: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import IndicatorPanel from './IndicatorPanel';

describe('IndicatorPanel', () => {
  it('lists 7 categories with 이동평균선 as the only active one', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    const buttons = screen.getAllByRole('button', { name: /이동평균선|일목균형표|볼린저밴드|슈퍼트렌드|매물대분석|엔벨로프|윌리엄스/ });
    expect(buttons).toHaveLength(7);
    // 6 of them are disabled.
    expect(buttons.filter((b) => (b as HTMLButtonElement).disabled)).toHaveLength(6);
    // 이동평균선 is active.
    expect((screen.getByRole('button', { name: '이동평균선' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders MovingAverageConfig in the right pane', () => {
    render(<IndicatorPanel onClose={() => {}} />);
    expect(screen.getByText('지난 n일 동안 주가 평균값을 이은 선')).toBeTruthy();
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<IndicatorPanel onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('✕ button calls onClose', () => {
    const onClose = vi.fn();
    render(<IndicatorPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('backdrop click calls onClose, inside click does not', () => {
    const onClose = vi.fn();
    render(<IndicatorPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('이동평균선').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement**

```tsx
import { useEffect } from 'react';
import MovingAverageConfig from './MovingAverageConfig';

type CategoryId = 'moving-average' | 'ichimoku' | 'bollinger' | 'supertrend' | 'volume-profile' | 'envelope' | 'williams';

const CATEGORIES: ReadonlyArray<{ id: CategoryId; label: string; active: boolean }> = [
  { id: 'moving-average', label: '이동평균선',  active: true  },
  { id: 'ichimoku',       label: '일목균형표',  active: false },
  { id: 'bollinger',      label: '볼린저밴드',  active: false },
  { id: 'supertrend',     label: '슈퍼트렌드',  active: false },
  { id: 'volume-profile', label: '매물대분석',  active: false },
  { id: 'envelope',       label: '엔벨로프',    active: false },
  { id: 'williams',       label: '윌리엄스 프랙탈', active: false },
];

type Props = {
  onClose: () => void;
};

export default function IndicatorPanel({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="지표"
      onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] w-[640px] max-w-[90vw] flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-fg text-base font-medium">지표</h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="text-fg-dim hover:text-fg text-lg leading-none"
          >
            ✕
          </button>
        </div>
        <div className="flex">
          <nav className="w-[180px] py-2 border-r border-border" aria-label="지표 카테고리">
            <div className="text-fg-dimmer text-[10px] uppercase tracking-wider px-4 pb-2">상단 지표</div>
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={!c.active}
                aria-pressed={c.active}
                className={
                  c.active
                    ? 'block w-full text-left px-4 py-2 text-sm bg-bg-input text-fg font-medium border-l-2 border-accent'
                    : 'block w-full text-left px-4 py-2 text-sm text-fg-dimmer opacity-50 cursor-not-allowed'
                }
                title={c.active ? undefined : '추후 지원 예정'}
              >
                {c.label}
              </button>
            ))}
          </nav>
          <div className="flex-1 px-5 py-4">
            <MovingAverageConfig />
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx
git commit -m "feat(live): IndicatorPanel modal — 7 categories, MA active"
```

---

## Phase D — Wire-up

### Task 13: `LiveToolbar` "지표" 버튼

**Files:**
- Modify: `frontend/src/live/LiveToolbar.tsx`

- [ ] **Step 1: Update component**

`LiveToolbar`는 현재 props가 없다. panel 토글을 위해 props 추가:

```tsx
import { LIVE_TIMEFRAMES, useLivePageStore } from '../state/livePage';

type Props = {
  onOpenIndicators: () => void;
};

export function LiveToolbar({ onOpenIndicators }: Props) {
  const tf = useLivePageStore((s) => s.candleTimeframe);
  const setTf = useLivePageStore((s) => s.setCandleTimeframe);
  return (
    <div
      data-testid="live-toolbar"
      className="flex items-center gap-2 border-b px-3"
      style={{
        height: 'var(--h-toolbar)',
        borderColor: 'var(--border)',
        background: 'var(--bg-card)',
      }}
    >
      <div className="flex gap-1" role="group" aria-label="Timeframe">
        {LIVE_TIMEFRAMES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTf(t)}
            aria-pressed={tf === t}
            className="px-2 py-1 rounded font-mono"
            style={{
              background: tf === t ? 'var(--tint-selection)' : 'var(--bg-input)',
              color: tf === t ? 'var(--accent)' : 'var(--fg-dim)',
              fontSize: 'var(--text-xs)',
              border: '1px solid',
              borderColor: tf === t ? 'var(--accent)' : 'var(--border)',
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <button
        type="button"
        data-testid="live-indicators-button"
        onClick={onOpenIndicators}
        aria-label="지표"
        className="ml-auto px-2 py-1 rounded text-sm"
        style={{
          background: 'var(--bg-input)',
          color: 'var(--fg-dim)',
          border: '1px solid var(--border)',
        }}
      >
        📈 지표
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify with existing tests**

There are no `LiveToolbar.test.tsx` files (verify): `ls frontend/src/live/LiveToolbar*`

Run all live tests: `cd frontend && npx vitest run src/live/`
Expected: no regression. The new button is only triggered through prop, so existing LivePage callers will need the prop in Task 14 — that integration will be the validating test.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/live/LiveToolbar.tsx
git commit -m "feat(live): LiveToolbar 지표 button (wire-up in next task)"
```

---

### Task 14: `LivePage` panel state wire-up

**Files:**
- Modify: `frontend/src/live/LivePage.tsx`

- [ ] **Step 1: Inspect current LivePage.tsx**

Run: `cd frontend && head -40 src/live/LivePage.tsx`

Identify where LiveToolbar is rendered. Add panel state and pass the callback. (Assume the file is short — read fully if needed.)

- [ ] **Step 2: Add panel state and IndicatorPanel mount**

At the top of `LivePage.tsx`, add the import + state:

```tsx
import { useState } from 'react';
import IndicatorPanel from './indicators/IndicatorPanel';
```

In the component body, add (before the return):

```tsx
const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);
```

Find the existing `<LiveToolbar />` JSX and replace with:

```tsx
<LiveToolbar onOpenIndicators={() => setIndicatorPanelOpen(true)} />
```

At the end of the page's JSX (sibling to the workarea/header), append:

```tsx
{indicatorPanelOpen && (
  <IndicatorPanel onClose={() => setIndicatorPanelOpen(false)} />
)}
```

- [ ] **Step 3: Run existing LivePage tests + build**

Run: `cd frontend && npx vitest run src/live/LivePage.test.tsx && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/live/LivePage.tsx
git commit -m "feat(live): IndicatorPanel open/close wired to LiveToolbar"
```

---

### Task 15: `LiveChartRoot` — mount `MovingAverageOverlay`

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx`

- [ ] **Step 1: Add import**

At the top of `LiveChartRoot.tsx`, alongside other live imports:

```tsx
import MovingAverageOverlay from './indicators/MovingAverageOverlay';
```

- [ ] **Step 2: Mount inside the chart-ready branch**

In the JSX, locate the block:

```tsx
{chart && bundle && axis.segments.length > 0 && (
  <>
    {paneSpecsForTimeframe(timeframe).map((spec, i) => (
      <RangeSeriesPane ... />
    ))}
    {isMinuteTimeframe(timeframe) && (
      <DayBoundaryOverlay chart={chart} axis={axis} />
    )}
  </>
)}
```

Right before `{isMinuteTimeframe(timeframe) && ...`, insert:

```tsx
<MovingAverageOverlay chart={chart} bundle={bundle} axis={axis} />
```

So MA renders on every timeframe (minute + D/W/M) since it's a candle overlay.

- [ ] **Step 3: Run LiveChartRoot tests + build**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx && npm run build`
Expected: PASS. The existing chart-root tests mock lightweight-charts and won't break — `MovingAverageOverlay` uses the mocked `addSeries` API just as RangeSeriesPane does.

If `LiveChartRoot.test.tsx` mocks `addSeries` strictly and the new mount changes the call count, update the assertions to use `>=` rather than `===`, or extend the mock to no-op extra calls.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx
git commit -m "feat(live): mount MovingAverageOverlay on chart-ready (all timeframes)"
```

---

### Task 16: Manual verification + integration check

**Files:** none (verification only)

- [ ] **Step 1: Start backend + frontend dev servers**

In two terminals:
```bash
# Terminal A — backend (CLAUDE.md pattern)
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga

# Terminal B — frontend
cd frontend && npm run dev
```

- [ ] **Step 2: Open /live via /browse skill**

Run: `B=/home/dev/.claude/skills/gstack/browse/dist/browse && $B goto http://localhost:5173/live`

- [ ] **Step 3: Walk through manual verification scenarios (spec §Testing)**

For each step, verify the listed expectation:

1. 종목 선택 후 차트에 4개의 색 다른 line 표시 (MA 5/20/60/120).
2. LiveToolbar "📈 지표" 클릭 → IndicatorPanel 모달 오픈.
3. 좌측 7개 카테고리 중 "이동평균선"만 활성 (다른 6개 비활성 + tooltip "추후 지원 예정").
4. 우측 4개 슬롯 행 각각: 기간1/2/3/4 라벨, 토글, 색상 swatch, 굵기 dropdown, 소스 dropdown, 기간 입력.
5. "⊕ 기간 추가" 클릭 → 5번째 슬롯 등장, 차트에 새 line.
6. 슬롯의 ✕ 클릭 → 차트에서 사라짐.
7. 기간 입력 5 → 10 변경 후 blur, 차트 line이 setData만 (시각적 깜빡임 없음).
8. 색상 swatch 클릭 → 8색 팔레트 popover, 새 색 선택, 즉시 반영.
9. 소스를 '종가' → '고가' 변경, line 위치 이동.
10. 굵기 1 → 3 변경, line 굵기 변경.
11. 페이지 새로고침 후 설정 유지 (`localStorage('live.indicators.v1')`).
12. timeframe 1m → D 변경, MA line이 D 단위로 재계산.
13. /replay 페이지 이동, 기존 5슬롯 MA 동작 그대로 (회귀 없음).

- [ ] **Step 4: Browser console — no errors**

Run: `B=/home/dev/.claude/skills/gstack/browse/dist/browse && $B console --errors`
Expected: empty.

- [ ] **Step 5: Final commit (manual verification log if needed)**

If any post-fix is necessary, commit those fixes here. Otherwise this task ends without a commit.

---

## Acceptance Criteria

- [ ] All vitest tests pass: `cd frontend && npm run test`
- [ ] Frontend builds: `cd frontend && npm run build`
- [ ] /replay MA functionally identical (existing tests + manual check).
- [ ] /live MA: 4 default slots render, add/remove works, period/color/width/source edits propagate, persistence survives reload.
- [ ] No errors in browser console on /live.

## Deferred review notes

_(populated by Plan reviews stage if applicable)_
