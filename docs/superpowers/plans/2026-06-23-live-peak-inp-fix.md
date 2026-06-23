# Live Peak INP Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the 1.2-1.5s main-thread stalls on `/live` by making daily ask/bid peak tracking incremental and avoiding repeated candle-range scans.

**Architecture:** Keep existing `useDayAskPeaks` and `useDayBidPeaks` public behavior, but move expensive derived state into small pure helpers with focused tests. The key change is to precompute today's candle-traded price coverage once per candle array and reuse that predicate inside each live tick instead of calling `candles.some(...)` for every price candidate.

**Tech Stack:** React 18, Zustand, Vite, Vitest, lightweight-charts.

## Global Constraints

- Apply changes to the source tree that serves `localhost:5173`; verify with `readlink /proc/$(lsof -tiTCP:5173 -sTCP:LISTEN)/cwd`.
- Preserve ask/bid peak wire shapes: `AskPeak`, `BidPeak`, `LiveTodayAskPeak`, `LiveTodayBidPeak`.
- Do not change chart drawing semantics in `LiveAskPeakSegments.tsx` or `LiveBidPeakSegments.tsx`.
- Keep `/live` single-SSE-source invariant: do not add another `useLiveSeries` call.
- Any performance test must run locally with Vitest and not depend on the live backend.

---

## File Map

- Modify: `frontend/src/live/useDayAskPeaks.ts`
  - Owns today ask peak hook, traded-price tracking, observed ask price peaks, and ask-specific output conversion.
- Modify: `frontend/src/live/useDayBidPeaks.ts`
  - Owns today bid peak hook, traded-price tracking, observed bid price peaks, and bid-specific output conversion.
- Create: `frontend/src/live/candlePriceCoverage.ts`
  - Pure helper for building a cached predicate: `buildCandlePriceCoverage(candles, todayKst)`.
- Create: `frontend/src/live/candlePriceCoverage.test.ts`
  - Unit tests for KST date filtering and low/high inclusive price matching.
- Modify: `frontend/src/live/useDayAskPeaks.test.tsx`
  - Add regression tests proving ask peak logic does not repeatedly scan candles per observed price.
- Modify: `frontend/src/live/useDayBidPeaks.test.tsx`
  - Add equivalent bid regression tests.
- Create: `frontend/src/live/useDayPeaks.perf.test.tsx`
  - A synthetic Vitest performance guard for large `ob` / `trade` / `candles` inputs.

## Task 1: Add Cached Candle Price Coverage Helper

**Files:**
- Create: `frontend/src/live/candlePriceCoverage.ts`
- Create: `frontend/src/live/candlePriceCoverage.test.ts`

**Interfaces:**
- Produces: `buildCandlePriceCoverage(candles: readonly Candle[], todayKst: string): (price: number) => boolean`
- Consumes: `Candle` from `../api/types`, `realMsToYyyymmdd` from `./liveDateTime`

- [ ] **Step 1: Write failing tests**

Add `frontend/src/live/candlePriceCoverage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Candle } from '../api/types';
import { buildCandlePriceCoverage } from './candlePriceCoverage';

const candle = (ts_ms: number, low: number, high: number): Candle => ({
  ts_ms,
  open: low,
  high,
  low,
  close: high,
  vol_a: 0,
  vol_b: 0,
});

describe('buildCandlePriceCoverage', () => {
  it('matches prices inclusively inside today candle low/high ranges', () => {
    const today = Date.UTC(2026, 5, 23, 0, 0, 0);
    const covers = buildCandlePriceCoverage([candle(today, 100, 105)], '20260623');

    expect(covers(99)).toBe(false);
    expect(covers(100)).toBe(true);
    expect(covers(103)).toBe(true);
    expect(covers(105)).toBe(true);
    expect(covers(106)).toBe(false);
  });

  it('ignores candles outside todayKst', () => {
    const previousKstDay = Date.UTC(2026, 5, 22, 0, 0, 0);
    const covers = buildCandlePriceCoverage([candle(previousKstDay, 100, 105)], '20260623');

    expect(covers(103)).toBe(false);
  });

  it('ignores non-finite candle ranges and prices', () => {
    const today = Date.UTC(2026, 5, 23, 0, 0, 0);
    const covers = buildCandlePriceCoverage([
      { ...candle(today, 100, 105), low: Number.NaN },
      { ...candle(today, 200, 205), high: Number.POSITIVE_INFINITY },
    ], '20260623');

    expect(covers(102)).toBe(false);
    expect(covers(202)).toBe(false);
    expect(covers(Number.NaN)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/live/candlePriceCoverage.test.ts --run`

Expected: FAIL because `./candlePriceCoverage` does not exist.

- [ ] **Step 3: Implement helper**

Create `frontend/src/live/candlePriceCoverage.ts`:

```ts
import type { Candle } from '../api/types';
import { realMsToYyyymmdd } from './liveDateTime';

type PriceRange = { low: number; high: number };

export function buildCandlePriceCoverage(
  candles: readonly Candle[],
  todayKst: string,
): (price: number) => boolean {
  const ranges: PriceRange[] = [];
  for (const c of candles) {
    if (
      realMsToYyyymmdd(c.ts_ms) !== todayKst ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.high)
    ) {
      continue;
    }
    ranges.push({ low: c.low, high: c.high });
  }

  return (price: number): boolean => {
    if (!Number.isFinite(price)) return false;
    for (const r of ranges) {
      if (r.low <= price && price <= r.high) return true;
    }
    return false;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- src/live/candlePriceCoverage.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/candlePriceCoverage.ts frontend/src/live/candlePriceCoverage.test.ts
git commit -m "test: add live candle price coverage helper"
```

## Task 2: Wire Cached Coverage Into Ask Peak Hook

**Files:**
- Modify: `frontend/src/live/useDayAskPeaks.ts`
- Modify: `frontend/src/live/useDayAskPeaks.test.tsx`

**Interfaces:**
- Consumes: `buildCandlePriceCoverage(candles, todayKst)` from Task 1
- Produces: unchanged `useDayAskPeaks(...)` and `useTodayAllPriceAskPeak(...)`

- [ ] **Step 1: Add regression test**

Append to `frontend/src/live/useDayAskPeaks.test.tsx`:

```ts
it('keeps live ask peak updates responsive with many candles and repeated prices', () => {
  const candles = Array.from({ length: 1500 }, (_, i) => ({
    ts_ms: Date.UTC(2026, 5, 23, 0, 0, 0) + i * 60_000,
    open: 1000 + i,
    high: 1005 + i,
    low: 1000 + i,
    close: 1005 + i,
    vol_a: 0,
    vol_b: 0,
  }));
  const ob = Array.from({ length: 1000 }, (_, i) => ({
    t_ms: Date.UTC(2026, 5, 23, 0, 0, 0) + i * 1000,
    total_ask_qty: 1,
    total_bid_qty: 1,
    asks: Array.from({ length: 10 }, (_unused, level) => ({ price: 1200 + level, qty: 100 + i + level })),
    bids: Array.from({ length: 10 }, (_unused, level) => ({ price: 1100 - level, qty: 100 + i + level })),
  }));

  const started = performance.now();
  const { result } = renderHook(() =>
    useDayAskPeaks(ob, [], [], '20260623', '005930', null, candles),
  );
  const elapsed = performance.now() - started;

  expect(result.current.at(-1)?.price).toBeGreaterThanOrEqual(1200);
  expect(elapsed).toBeLessThan(250);
});
```

- [ ] **Step 2: Run regression test**

Run: `cd frontend && npm test -- src/live/useDayAskPeaks.test.tsx --run`

Expected before implementation: FAIL or noticeably slow on the new performance guard.

- [ ] **Step 3: Replace per-price candle scan with cached predicate**

In `frontend/src/live/useDayAskPeaks.ts`, import the helper:

```ts
import { buildCandlePriceCoverage } from './candlePriceCoverage';
```

Replace `candleRangeContainsPrice(...)` call sites inside `useDayAskPeaks` with one memoized predicate:

```ts
const isCandleRangeTraded = useMemo(
  () => buildCandlePriceCoverage(todayCandles, todayKst),
  [todayCandles, todayKst],
);
```

Then in the live effect use the predicate:

```ts
const allowPrice = (price: number) => (
  tradePriceRef.current.prices.has(price) || isCandleRangeTraded(price)
);
const s = reduceDayAskPeak(stateRef.current, liveSeed, unreadOb, allowPrice);
stateRef.current = s;
const bestPeak = bestTradedObservedPeak(
  s.peak ?? liveSeed,
  observedPricePeaksRef.current,
  tradePriceRef.current.prices,
  isCandleRangeTraded,
);
const seedPeaks = bestPeak ? [...liveSeeds, bestPeak] : liveSeeds;
const nextPeaks = topTradedObservedPeaks(
  seedPeaks,
  observedPricePeaksRef.current,
  tradePriceRef.current.prices,
  isCandleRangeTraded,
);
```

Update the effect dependency list:

```ts
}, [ob, trade, liveSeed, todayAskPeak, todayKst, isCandleRangeTraded]);
```

- [ ] **Step 4: Run ask tests**

Run: `cd frontend && npm test -- src/live/useDayAskPeaks.test.tsx src/live/candlePriceCoverage.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/useDayAskPeaks.ts frontend/src/live/useDayAskPeaks.test.tsx frontend/src/live/candlePriceCoverage.ts frontend/src/live/candlePriceCoverage.test.ts
git commit -m "perf: cache candle price coverage for ask peaks"
```

## Task 3: Wire Cached Coverage Into Bid Peak Hook

**Files:**
- Modify: `frontend/src/live/useDayBidPeaks.ts`
- Modify: `frontend/src/live/useDayBidPeaks.test.tsx`

**Interfaces:**
- Consumes: `buildCandlePriceCoverage(candles, todayKst)` from Task 1
- Produces: unchanged `useDayBidPeaks(...)` and `useTodayAllPriceBidPeak(...)`

- [ ] **Step 1: Add regression test**

Append to `frontend/src/live/useDayBidPeaks.test.tsx`:

```ts
it('keeps live bid peak updates responsive with many candles and repeated prices', () => {
  const candles = Array.from({ length: 1500 }, (_, i) => ({
    ts_ms: Date.UTC(2026, 5, 23, 0, 0, 0) + i * 60_000,
    open: 1000 + i,
    high: 1005 + i,
    low: 1000 + i,
    close: 1005 + i,
    vol_a: 0,
    vol_b: 0,
  }));
  const ob = Array.from({ length: 1000 }, (_, i) => ({
    t_ms: Date.UTC(2026, 5, 23, 0, 0, 0) + i * 1000,
    total_ask_qty: 1,
    total_bid_qty: 1,
    asks: Array.from({ length: 10 }, (_unused, level) => ({ price: 1300 + level, qty: 100 + i + level })),
    bids: Array.from({ length: 10 }, (_unused, level) => ({ price: 1200 + level, qty: 100 + i + level })),
  }));

  const started = performance.now();
  const { result } = renderHook(() =>
    useDayBidPeaks(ob, [], [], '20260623', '005930', null, candles),
  );
  const elapsed = performance.now() - started;

  expect(result.current.at(-1)?.price).toBeGreaterThanOrEqual(1200);
  expect(elapsed).toBeLessThan(250);
});
```

- [ ] **Step 2: Run regression test**

Run: `cd frontend && npm test -- src/live/useDayBidPeaks.test.tsx --run`

Expected before implementation: FAIL or noticeably slow on the new performance guard.

- [ ] **Step 3: Replace per-price candle scan with cached predicate**

In `frontend/src/live/useDayBidPeaks.ts`, import:

```ts
import { buildCandlePriceCoverage } from './candlePriceCoverage';
```

Inside `useDayBidPeaks`, add:

```ts
const isCandleRangeTraded = useMemo(
  () => buildCandlePriceCoverage(todayCandles, todayKst),
  [todayCandles, todayKst],
);
```

Then update the live effect:

```ts
const allowPrice = (price: number) => (
  tradePriceRef.current.prices.has(price) || isCandleRangeTraded(price)
);
const s = reduceDayBidPeak(stateRef.current, liveSeed, unreadOb, allowPrice);
stateRef.current = s;
setTodayPeak(bestTradedObservedPeak(
  s.peak ?? liveSeed,
  observedPricePeaksRef.current,
  tradePriceRef.current.prices,
  isCandleRangeTraded,
));
```

Update the effect dependency list:

```ts
}, [ob, trade, liveSeed, todayBidPeak, todayKst, isCandleRangeTraded]);
```

- [ ] **Step 4: Run bid tests**

Run: `cd frontend && npm test -- src/live/useDayBidPeaks.test.tsx src/live/candlePriceCoverage.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/useDayBidPeaks.ts frontend/src/live/useDayBidPeaks.test.tsx frontend/src/live/candlePriceCoverage.ts frontend/src/live/candlePriceCoverage.test.ts
git commit -m "perf: cache candle price coverage for bid peaks"
```

## Task 4: Add Combined Performance Guard

**Files:**
- Create: `frontend/src/live/useDayPeaks.perf.test.tsx`

**Interfaces:**
- Consumes: `useDayAskPeaks(...)`, `useDayBidPeaks(...)`
- Produces: a fast local regression guard for the measured INP root cause

- [ ] **Step 1: Add combined performance test**

Create `frontend/src/live/useDayPeaks.perf.test.tsx`:

```ts
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDayAskPeaks } from './useDayAskPeaks';
import { useDayBidPeaks } from './useDayBidPeaks';

const base = Date.UTC(2026, 5, 23, 0, 0, 0);

describe('live day peak performance', () => {
  it('processes large live buffers without second-scale stalls', () => {
    const candles = Array.from({ length: 2500 }, (_, i) => ({
      ts_ms: base + i * 60_000,
      open: 1000 + i,
      high: 1010 + i,
      low: 1000 + i,
      close: 1005 + i,
      vol_a: 0,
      vol_b: 0,
    }));
    const ob = Array.from({ length: 2000 }, (_, i) => ({
      t_ms: base + i * 1000,
      total_ask_qty: 1000 + i,
      total_bid_qty: 900 + i,
      asks: Array.from({ length: 10 }, (_unused, level) => ({ price: 1400 + level, qty: 100 + i + level })),
      bids: Array.from({ length: 10 }, (_unused, level) => ({ price: 1300 + level, qty: 120 + i + level })),
    }));
    const trade = Array.from({ length: 2000 }, (_, i) => ({
      t_ms: base + i * 1000,
      trades: [{ side: i % 2 === 0 ? 1 : -1, price: 1300 + (i % 10), qty: 1 }],
    }));

    const started = performance.now();
    renderHook(() => useDayAskPeaks(ob, trade, [], '20260623', '005930', null, candles));
    renderHook(() => useDayBidPeaks(ob, trade, [], '20260623', '005930', null, candles));
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run combined performance test**

Run: `cd frontend && npm test -- src/live/useDayPeaks.perf.test.tsx --run`

Expected: PASS after Tasks 2 and 3.

- [ ] **Step 3: Run focused live test group**

Run:

```bash
cd frontend
npm test -- \
  src/live/useDayAskPeaks.test.tsx \
  src/live/useDayBidPeaks.test.tsx \
  src/live/useDayPeaks.perf.test.tsx \
  src/live/candlePriceCoverage.test.ts \
  --run
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/live/useDayPeaks.perf.test.tsx
git commit -m "test: guard live day peak performance"
```

## Task 5: Browser Verification Against INP Symptom

**Files:**
- No code changes unless Task 4 fails to explain the browser result.

**Interfaces:**
- Consumes: local dev server at `http://localhost:5173/live`
- Produces: measured before/after evidence

- [ ] **Step 1: Verify dev server source tree**

Run:

```bash
lsof -iTCP:5173 -sTCP:LISTEN
readlink /proc/$(lsof -tiTCP:5173 -sTCP:LISTEN | head -1)/cwd
```

Expected: cwd points at the repository where Tasks 1-4 were applied.

- [ ] **Step 2: Load live page and select a liquid symbol**

Open `http://localhost:5173/live`, select `005930`, wait until canvases render and the title shows 삼성전자.

- [ ] **Step 3: Measure idle long tasks**

Run in DevTools console:

```js
window.__hogaPerf?.longObs?.disconnect?.();
window.__hogaPerf = { longtasks: [], rafGaps: [] };
window.__hogaPerf.longObs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    window.__hogaPerf.longtasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) });
  }
});
window.__hogaPerf.longObs.observe({ type: 'longtask', buffered: false });
let last = performance.now();
function hogaRafProbe(now) {
  const gap = now - last;
  if (gap > 32) window.__hogaPerf.rafGaps.push({ at: Math.round(now), gap: Math.round(gap) });
  last = now;
  window.__hogaPerf.rafId = requestAnimationFrame(hogaRafProbe);
}
window.__hogaPerf.rafId = requestAnimationFrame(hogaRafProbe);
setTimeout(() => {
  cancelAnimationFrame(window.__hogaPerf.rafId);
  console.table(window.__hogaPerf.longtasks);
  console.table(window.__hogaPerf.rafGaps);
}, 12000);
```

Expected after fix: no repeated 1.2-1.5s long tasks.

- [ ] **Step 4: Measure drag interaction**

Use Chrome DevTools Performance panel:

1. Start recording.
2. Drag the chart canvas horizontally for 5-10 seconds.
3. Stop recording.
4. Inspect Main thread.

Expected after fix: no repeated `computeDayAskPeak`, `computeDayBidPeak`, `hasDeep`, or `candleRangeContainsPrice` blocks above 50ms; canvas pointer INP should no longer show 800ms-1.3s spikes.

- [ ] **Step 5: Commit verification notes**

If this repo keeps investigation notes, add a short note under an existing diagnostics doc. If not, include the before/after numbers in the PR description instead of creating a new doc.

## Self-Review

- Spec coverage: The plan addresses the measured INP symptom, the peak hook CPU root cause, tests, and browser verification.
- Placeholder scan: No task uses TBD/TODO/fill-in language.
- Type consistency: `buildCandlePriceCoverage(candles, todayKst)` is defined once and reused by ask and bid hooks with the same signature.
