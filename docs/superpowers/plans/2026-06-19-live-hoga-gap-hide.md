# Live Hoga Gap Hide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the Live page's 총잔량 and 호가비 indicator lines whenever the candle timeline has no usable orderbook data, including empty hoga gaps and already-detected 3-level auction books.

**Architecture:** Keep the data model unchanged and solve the visual connector problem in the chart projection layer, where lightweight-charts data points and per-point transparent colors are already used to break auction-window connectors. Add one focused utility that converts sparse hoga points into explicit transparent "gap sentinel" points based on candle bucket times, then use it from the 총잔량 and 호가비 projectors before they apply their existing auction masking logic.

**Tech Stack:** TypeScript, React, lightweight-charts v5, Vitest, existing `VirtualAxis`, `RangeBundle`, `QuoteRatioPoint`, and chart projector patterns.

## Global Constraints

- Do not change backend `/api/range`, `query_bucketed_ratio`, or SSE payload contracts for this feature.
- Preserve existing closing auction behavior: 3-level auction buckets still render hidden/flat according to the current auction mask and `(0,0)` sentinel contracts.
- Do not make 캔들/거래량 disappear when hoga data is missing; only 총잔량 and 호가비 should be visually hidden.
- Do not use `WhitespaceData` or missing points as the gap mechanism; `lightweight-charts` interpolates across both in this codebase's documented behavior.
- Preserve `/live` split past/today cache invariants: projector output for cached past plus today must match full projection for normal day-boundary cases.
- Keep the first implementation scoped to bucket-aligned candle gaps; no new user setting is required.

---

## File Structure

- Create `frontend/src/chart/util/hogaGapHide.ts`
  - Owns detection of missing hoga buckets on the candle timeline.
  - Exports a small, chart-library-agnostic helper that injects synthetic `QuoteRatioPoint` sentinels with all numeric hoga values set to `0`.
  - Exports `isSyntheticHogaGapPoint` so projectors can style those sentinels as transparent.

- Modify `frontend/src/chart/projectors/quoteTotals.ts`
  - Calls the helper from both direct projection (`projectBid` / `projectAsk`) and the actual `QUOTE_TOTALS_SPEC.series[*].data` cached path.
  - Uses a shared bundle-to-points adapter so `makePastCachedProjector` receives gap-expanded quote-ratio points.
  - Styles synthetic gap points with `LINE_HIDDEN_COLOR` and calls `maskOutgoingConnector` to break the incoming connector.

- Modify `frontend/src/chart/projectors/ratio.ts`
  - Calls the helper from both direct projection (`projectRatio`) and the actual `RATIO_SPEC.series[0].data` cached path.
  - Uses a shared bundle-to-points adapter so `makePastCachedProjector` receives gap-expanded quote-ratio points.
  - Styles synthetic gap points with `BASELINE_HIDDEN_COLORS` and calls `maskOutgoingConnector`.

- Modify `frontend/src/chart/projectors/quoteTotals.test.ts`
  - Adds regression tests for a candle-only gap between two hoga buckets.
  - Verifies both bid and ask series hide the connector into and out of the gap.

- Modify `frontend/src/chart/projectors/ratio.test.ts`
  - Adds regression tests for the same candle-only hoga gap in the ratio baseline series.

- Create `frontend/src/chart/util/hogaGapHide.test.ts`
  - Unit tests helper behavior without lightweight-charts details.

## Interfaces

The new utility exports exactly these interfaces:

```ts
import type { Candle, QuoteRatioPoint } from '../../api/types';

export type HogaGapPoint = QuoteRatioPoint & { __syntheticHogaGap: true };

export function isSyntheticHogaGapPoint(p: QuoteRatioPoint): p is HogaGapPoint;

export function withHogaGapSentinels(
  points: readonly QuoteRatioPoint[],
  candles: readonly Candle[],
  bucketMs: number,
): QuoteRatioPoint[];
```

Rules:

- If `points.length === 0`, return `[]`. This avoids inventing a flat invisible series for a whole hoga-less chart.
- If `candles.length === 0`, return a sorted shallow copy of `points`.
- A candle bucket has hoga if any quote-ratio point has `p.t === floor(c.ts_ms / bucketMs) * bucketMs`.
- For each candle bucket between the first and last hoga bucket, inject one synthetic point when no hoga point exists.
- Synthetic points use `{ bid_total: 0, ask_total: 0, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0, __syntheticHogaGap: true }`.
- Return points sorted by `t`; for equal `t`, real hoga points must appear before synthetic points. The implementation should not normally create duplicate synthetic points at real hoga times.

---

### Task 1: Add Hoga Gap Sentinel Helper

**Files:**
- Create: `frontend/src/chart/util/hogaGapHide.ts`
- Create: `frontend/src/chart/util/hogaGapHide.test.ts`

**Interfaces:**
- Consumes: `Candle` and `QuoteRatioPoint` from `frontend/src/api/types.ts`
- Produces: `withHogaGapSentinels(points, candles, bucketMs)` and `isSyntheticHogaGapPoint(p)`

- [ ] **Step 1: Write the failing helper tests**

Create `frontend/src/chart/util/hogaGapHide.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Candle, QuoteRatioPoint } from '../../api/types';
import { isSyntheticHogaGapPoint, withHogaGapSentinels } from './hogaGapHide';

const MINUTE = 60_000;
const T0 = 1_779_926_400_000;

function candle(t: number): Candle {
  return { ts_ms: t, open: 1, high: 1, low: 1, close: 1, vol_a: 0, vol_b: 0 };
}

function qr(t: number, bid = 100, ask = 200): QuoteRatioPoint {
  return {
    t,
    bid_total: bid,
    ask_total: ask,
    bid_max: bid,
    ask_max: ask,
    imb_max_bid: bid,
    imb_max_ask: ask,
  };
}

describe('withHogaGapSentinels', () => {
  it('returns an empty array when there are no hoga points at all', () => {
    expect(withHogaGapSentinels([], [candle(T0), candle(T0 + MINUTE)], MINUTE)).toEqual([]);
  });

  it('returns sorted real points when candles are absent', () => {
    expect(withHogaGapSentinels([qr(T0 + MINUTE), qr(T0)], [], MINUTE).map((p) => p.t)).toEqual([
      T0,
      T0 + MINUTE,
    ]);
  });

  it('injects a synthetic zero point for candle buckets without hoga between real hoga points', () => {
    const out = withHogaGapSentinels(
      [qr(T0, 10, 20), qr(T0 + 2 * MINUTE, 30, 40)],
      [candle(T0), candle(T0 + MINUTE), candle(T0 + 2 * MINUTE)],
      MINUTE,
    );

    expect(out.map((p) => p.t)).toEqual([T0, T0 + MINUTE, T0 + 2 * MINUTE]);
    expect(isSyntheticHogaGapPoint(out[0])).toBe(false);
    expect(isSyntheticHogaGapPoint(out[1])).toBe(true);
    expect(out[1]).toMatchObject({
      bid_total: 0,
      ask_total: 0,
      bid_max: 0,
      ask_max: 0,
      imb_max_bid: 0,
      imb_max_ask: 0,
    });
    expect(isSyntheticHogaGapPoint(out[2])).toBe(false);
  });

  it('does not inject leading or trailing sentinels outside the hoga-covered span', () => {
    const out = withHogaGapSentinels(
      [qr(T0 + MINUTE), qr(T0 + 3 * MINUTE)],
      [
        candle(T0),
        candle(T0 + MINUTE),
        candle(T0 + 2 * MINUTE),
        candle(T0 + 3 * MINUTE),
        candle(T0 + 4 * MINUTE),
      ],
      MINUTE,
    );

    expect(out.map((p) => p.t)).toEqual([T0 + MINUTE, T0 + 2 * MINUTE, T0 + 3 * MINUTE]);
    expect(isSyntheticHogaGapPoint(out[1])).toBe(true);
  });
});
```

- [ ] **Step 2: Run helper tests to verify they fail**

Run:

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops/frontend
npm test -- src/chart/util/hogaGapHide.test.ts --runInBand
```

Expected: FAIL with an import/resolve error because `./hogaGapHide` does not exist.

- [ ] **Step 3: Implement the helper**

Create `frontend/src/chart/util/hogaGapHide.ts`:

```ts
import type { Candle, QuoteRatioPoint } from '../../api/types';

export type HogaGapPoint = QuoteRatioPoint & { __syntheticHogaGap: true };

const ZERO_HOGA_FIELDS = {
  bid_total: 0,
  ask_total: 0,
  bid_max: 0,
  ask_max: 0,
  imb_max_bid: 0,
  imb_max_ask: 0,
} as const;

function bucketStart(t: number, bucketMs: number): number {
  return Math.floor(t / bucketMs) * bucketMs;
}

function syntheticGapPoint(t: number): HogaGapPoint {
  return { t, ...ZERO_HOGA_FIELDS, __syntheticHogaGap: true };
}

export function isSyntheticHogaGapPoint(p: QuoteRatioPoint): p is HogaGapPoint {
  return (p as Partial<HogaGapPoint>).__syntheticHogaGap === true;
}

export function withHogaGapSentinels(
  points: readonly QuoteRatioPoint[],
  candles: readonly Candle[],
  bucketMs: number,
): QuoteRatioPoint[] {
  if (bucketMs <= 0) throw new Error(`bucketMs must be positive, got ${bucketMs}`);
  const real = [...points].sort((a, b) => a.t - b.t);
  if (real.length === 0 || candles.length === 0) return real;

  const hogaTimes = new Set(real.map((p) => p.t));
  const firstHogaT = real[0].t;
  const lastHogaT = real[real.length - 1].t;
  const sentinelByT = new Map<number, HogaGapPoint>();

  for (const c of candles) {
    const t = bucketStart(c.ts_ms, bucketMs);
    if (t < firstHogaT || t > lastHogaT || hogaTimes.has(t)) continue;
    sentinelByT.set(t, syntheticGapPoint(t));
  }

  if (sentinelByT.size === 0) return real;
  return [...real, ...sentinelByT.values()].sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    if (isSyntheticHogaGapPoint(a) === isSyntheticHogaGapPoint(b)) return 0;
    return isSyntheticHogaGapPoint(a) ? 1 : -1;
  });
}
```

- [ ] **Step 4: Run helper tests to verify they pass**

Run:

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops/frontend
npm test -- src/chart/util/hogaGapHide.test.ts --runInBand
```

Expected: PASS for all tests in `hogaGapHide.test.ts`.

- [ ] **Step 5: Commit**

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops
git add frontend/src/chart/util/hogaGapHide.ts frontend/src/chart/util/hogaGapHide.test.ts
git commit -m "feat: add hoga gap sentinels"
```

---

### Task 2: Apply Gap Sentinels To 총잔량 Projector And Cached Pane Data

**Files:**
- Modify: `frontend/src/chart/projectors/quoteTotals.ts`
- Modify: `frontend/src/chart/projectors/quoteTotals.test.ts`

**Interfaces:**
- Consumes: `withHogaGapSentinels(points, candles, bucketMs)` and `isSyntheticHogaGapPoint(p)` from Task 1
- Produces: `projectBid(bundle, axis, auctionWindowMask)`, `projectAsk(bundle, axis, auctionWindowMask)`, and `QUOTE_TOTALS_SPEC.series[*].data(bundle, axis, ctx)` that hide missing-hoga candle buckets

- [ ] **Step 1: Write failing 총잔량 projector tests**

Append this block to `frontend/src/chart/projectors/quoteTotals.test.ts`:

```ts
describe('hoga data gaps', () => {
  function candle(t: number) {
    return { ts_ms: t, open: 1, high: 1, low: 1, close: 1, vol_a: 0, vol_b: 0 };
  }

  it('breaks bid/ask connectors across candle buckets with no hoga point', () => {
    const bundle: any = {
      bucket_ms: 60_000,
      candles: [
        candle(sessionOpenMs),
        candle(sessionOpenMs + 60_000),
        candle(sessionOpenMs + 120_000),
      ],
      quote_ratio: {
        points: [
          {
            t: sessionOpenMs,
            bid_total: 100,
            ask_total: 200,
            bid_max: 100,
            ask_max: 200,
            imb_max_bid: 100,
            imb_max_ask: 200,
          },
          {
            t: sessionOpenMs + 120_000,
            bid_total: 150,
            ask_total: 250,
            bid_max: 150,
            ask_max: 250,
            imb_max_bid: 150,
            imb_max_ask: 250,
          },
        ],
      },
    };

    expect(projectBid(bundle, axis, false)).toEqual([
      { time: 0, value: 100, color: 'rgba(0,0,0,0)' },
      { time: 60, value: 0, color: 'rgba(0,0,0,0)' },
      { time: 120, value: 150 },
    ]);
    expect(projectAsk(bundle, axis, false)).toEqual([
      { time: 0, value: 200, color: 'rgba(0,0,0,0)' },
      { time: 60, value: 0, color: 'rgba(0,0,0,0)' },
      { time: 120, value: 250 },
    ]);
  });

  it('does not synthesize a total line when all hoga data is missing', () => {
    const bundle: any = {
      bucket_ms: 60_000,
      candles: [candle(sessionOpenMs), candle(sessionOpenMs + 60_000)],
      quote_ratio: { points: [] },
    };

    expect(projectBid(bundle, axis, false)).toEqual([]);
    expect(projectAsk(bundle, axis, false)).toEqual([]);
  });

  it('applies the same hoga gap hiding through QUOTE_TOTALS_SPEC cached data path', () => {
    const bundle: any = {
      bucket_ms: 60_000,
      segments: [
        { date: '20260518', session_open_ms: sessionOpenMs, session_close_ms: sessionOpenMs + 23_400_000, source: 'kis_live' },
      ],
      candles: [
        candle(sessionOpenMs),
        candle(sessionOpenMs + 60_000),
        candle(sessionOpenMs + 120_000),
      ],
      quote_ratio: {
        points: [
          {
            t: sessionOpenMs,
            bid_total: 100,
            ask_total: 200,
            bid_max: 100,
            ask_max: 200,
            imb_max_bid: 100,
            imb_max_ask: 200,
          },
          {
            t: sessionOpenMs + 120_000,
            bid_total: 150,
            ask_total: 250,
            bid_max: 150,
            ask_max: 250,
            imb_max_bid: 150,
            imb_max_ask: 250,
          },
        ],
      },
    };
    const ctx = { auctionMask: false, intraMax: false, surgeEnabled: false, surgeApproachPct: 95, surgeRearmPct: 85, surgeStartHHMM: 900 };

    expect(QUOTE_TOTALS_SPEC.series[0].data(bundle, axis, ctx)).toEqual([
      { time: 0, value: 100, color: 'rgba(0,0,0,0)' },
      { time: 60, value: 0, color: 'rgba(0,0,0,0)' },
      { time: 120, value: 150 },
    ]);
    expect(QUOTE_TOTALS_SPEC.series[1].data(bundle, axis, ctx)).toEqual([
      { time: 0, value: 200, color: 'rgba(0,0,0,0)' },
      { time: 60, value: 0, color: 'rgba(0,0,0,0)' },
      { time: 120, value: 250 },
    ]);
  });
});
```

- [ ] **Step 2: Run 총잔량 projector tests to verify they fail**

Run:

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops/frontend
npm test -- src/chart/projectors/quoteTotals.test.ts --runInBand
```

Expected: FAIL because `projectBid`, `projectAsk`, and the cached `QUOTE_TOTALS_SPEC.series[*].data` path return only two connected real points instead of three entries with the transparent gap sentinel.

- [ ] **Step 3: Wire helper into `quoteTotals.ts`**

Modify imports in `frontend/src/chart/projectors/quoteTotals.ts`:

```ts
import { isSyntheticHogaGapPoint, withHogaGapSentinels } from '../util/hogaGapHide';
```

Add this adapter near `projectBid`:

```ts
const quoteRatioPointsForBundle = (bundle: RangeBundle): readonly QuoteRatioPoint[] =>
  withHogaGapSentinels(bundle.quote_ratio.points, bundle.candles ?? [], bundle.bucket_ms);
```

Replace `projectBid` with:

```ts
export function projectBid(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): LineData<Time>[] {
  return projectBidPoints(quoteRatioPointsForBundle(bundle), axis, auctionWindowMask);
}
```

Inside `projectBidPoints`, insert this block immediately after `const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;` and before the auction-window block:

```ts
    if (isSyntheticHogaGapPoint(p)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
```

Replace `projectAsk` with:

```ts
export function projectAsk(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): LineData<Time>[] {
  return projectAskPoints(quoteRatioPointsForBundle(bundle), axis, auctionWindowMask);
}
```

Inside `projectAskPoints`, insert this block immediately after `const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;` and before the auction-window block:

```ts
    if (isSyntheticHogaGapPoint(p)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
```

Replace the `getPoints` argument for both cached total projectors:

```ts
const bidCachedRaw = makePastCachedProjector(
  (pts: readonly QuoteRatioPoint[], a: VirtualAxis, flags: number) =>
    projectBidPoints(pts, a, (flags & 1) !== 0, (flags & 2) !== 0),
  quoteRatioPointsForBundle,
);
const askCachedRaw = makePastCachedProjector(
  (pts: readonly QuoteRatioPoint[], a: VirtualAxis, flags: number) =>
    projectAskPoints(pts, a, (flags & 1) !== 0, (flags & 2) !== 0),
  quoteRatioPointsForBundle,
);
```

- [ ] **Step 4: Run 총잔량 projector tests to verify they pass**

Run:

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops/frontend
npm test -- src/chart/projectors/quoteTotals.test.ts --runInBand
```

Expected: PASS for all tests in `quoteTotals.test.ts`.

- [ ] **Step 5: Run helper tests again**

Run:

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops/frontend
npm test -- src/chart/util/hogaGapHide.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops
git add frontend/src/chart/projectors/quoteTotals.ts frontend/src/chart/projectors/quoteTotals.test.ts
git commit -m "fix: hide quote totals across hoga gaps"
```

---

### Task 3: Apply Gap Sentinels To 호가비 Projector And Cached Pane Data

**Files:**
- Modify: `frontend/src/chart/projectors/ratio.ts`
- Modify: `frontend/src/chart/projectors/ratio.test.ts`

**Interfaces:**
- Consumes: `withHogaGapSentinels(points, candles, bucketMs)` and `isSyntheticHogaGapPoint(p)` from Task 1
- Produces: `projectRatio(bundle, axis, ctx)` and `RATIO_SPEC.series[0].data(bundle, axis, ctx)` that hide missing-hoga candle buckets

- [ ] **Step 1: Write failing 호가비 projector tests**

Append this block to `frontend/src/chart/projectors/ratio.test.ts`:

```ts
describe('hoga data gaps', () => {
  function candle(t: number) {
    return { ts_ms: t, open: 1, high: 1, low: 1, close: 1, vol_a: 0, vol_b: 0 };
  }

  it('breaks the ratio connector across candle buckets with no hoga point', () => {
    const bundle: any = {
      bucket_ms: 60_000,
      candles: [
        candle(sessionOpenMs),
        candle(sessionOpenMs + 60_000),
        candle(sessionOpenMs + 120_000),
      ],
      quote_ratio: {
        points: [
          {
            t: sessionOpenMs,
            bid_total: 100,
            ask_total: 200,
            bid_max: 100,
            ask_max: 200,
            imb_max_bid: 100,
            imb_max_ask: 200,
          },
          {
            t: sessionOpenMs + 120_000,
            bid_total: 200,
            ask_total: 100,
            bid_max: 200,
            ask_max: 100,
            imb_max_bid: 200,
            imb_max_ask: 100,
          },
        ],
      },
    };

    const data = projectRatio(bundle, axis, baseCtx) as any[];

    expect(data).toHaveLength(3);
    expect(data[0].time).toBe(0);
    expect(data[0].value).toBeCloseTo(1, 5);
    expect(data[0].topLineColor).toBe('rgba(0,0,0,0)');
    expect(data[0].bottomLineColor).toBe('rgba(0,0,0,0)');

    expect(data[1]).toMatchObject({
      time: 60,
      value: 0,
      topLineColor: 'rgba(0,0,0,0)',
      bottomLineColor: 'rgba(0,0,0,0)',
    });

    expect(data[2].time).toBe(120);
    expect(data[2].value).toBeCloseTo(-1, 5);
    expect(data[2].topLineColor).toBeUndefined();
  });

  it('does not synthesize a ratio baseline when all hoga data is missing', () => {
    const bundle: any = {
      bucket_ms: 60_000,
      candles: [candle(sessionOpenMs), candle(sessionOpenMs + 60_000)],
      quote_ratio: { points: [] },
    };

    expect(projectRatio(bundle, axis, baseCtx)).toEqual([]);
  });

  it('applies the same hoga gap hiding through RATIO_SPEC cached data path', () => {
    const bundle: any = {
      bucket_ms: 60_000,
      segments: [
        { date: '20260518', session_open_ms: sessionOpenMs, session_close_ms: sessionOpenMs + 23_400_000, source: 'kis_live' },
      ],
      candles: [
        candle(sessionOpenMs),
        candle(sessionOpenMs + 60_000),
        candle(sessionOpenMs + 120_000),
      ],
      quote_ratio: {
        points: [
          {
            t: sessionOpenMs,
            bid_total: 100,
            ask_total: 200,
            bid_max: 100,
            ask_max: 200,
            imb_max_bid: 100,
            imb_max_ask: 200,
          },
          {
            t: sessionOpenMs + 120_000,
            bid_total: 200,
            ask_total: 100,
            bid_max: 200,
            ask_max: 100,
            imb_max_bid: 200,
            imb_max_ask: 100,
          },
        ],
      },
    };

    const data = RATIO_SPEC.series[0].data(bundle, axis, baseCtx) as any[];

    expect(data).toHaveLength(3);
    expect(data[0].time).toBe(0);
    expect(data[0].value).toBeCloseTo(1, 5);
    expect(data[0].topLineColor).toBe('rgba(0,0,0,0)');
    expect(data[1]).toMatchObject({
      time: 60,
      value: 0,
      topLineColor: 'rgba(0,0,0,0)',
      bottomLineColor: 'rgba(0,0,0,0)',
    });
    expect(data[2].time).toBe(120);
    expect(data[2].value).toBeCloseTo(-1, 5);
  });
});
```

- [ ] **Step 2: Run 호가비 projector tests to verify they fail**

Run:

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops/frontend
npm test -- src/chart/projectors/ratio.test.ts --runInBand
```

Expected: FAIL because `projectRatio` and the cached `RATIO_SPEC.series[0].data` path return only two connected real points instead of a transparent gap sentinel between them.

- [ ] **Step 3: Wire helper into `ratio.ts`**

Modify imports in `frontend/src/chart/projectors/ratio.ts`:

```ts
import { isSyntheticHogaGapPoint, withHogaGapSentinels } from '../util/hogaGapHide';
```

Add this adapter near `projectRatio`:

```ts
const quoteRatioPointsForBundle = (bundle: RangeBundle): readonly QuoteRatioPoint[] =>
  withHogaGapSentinels(bundle.quote_ratio.points, bundle.candles ?? [], bundle.bucket_ms);
```

Replace `projectRatio` with:

```ts
export function projectRatio(
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: RatioPaneContext,
): BaselineData<Time>[] {
  return projectRatioPoints(quoteRatioPointsForBundle(bundle), axis, ctx);
}
```

Inside `projectRatioPoints`, insert this block immediately after `const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;` and before the auction-window block:

```ts
    if (isSyntheticHogaGapPoint(p)) {
      maskOutgoingConnector(out, BASELINE_HIDDEN_COLORS);
      out.push({ time, value: 0, ...BASELINE_HIDDEN_COLORS });
      continue;
    }
```

Replace the cached ratio projector creation:

```ts
const ratioCachedData = makePastCachedProjector(projectRatioPoints, quoteRatioPointsForBundle);
```

The old line to replace is:

```ts
const ratioCachedData = makePastCachedProjector(projectRatioPoints, (b) => b.quote_ratio.points);
```

- [ ] **Step 4: Run 호가비 projector tests to verify they pass**

Run:

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops/frontend
npm test -- src/chart/projectors/ratio.test.ts --runInBand
```

Expected: PASS for all tests in `ratio.test.ts`.

- [ ] **Step 5: Run the focused hoga indicator test set**

Run:

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops/frontend
npm test -- src/chart/util/hogaGapHide.test.ts src/chart/projectors/quoteTotals.test.ts src/chart/projectors/ratio.test.ts src/live/bucketHogaSeries.test.ts --runInBand
```

Expected: PASS for all focused tests.

- [ ] **Step 6: Commit**

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops
git add frontend/src/chart/projectors/ratio.ts frontend/src/chart/projectors/ratio.test.ts
git commit -m "fix: hide ratio across hoga gaps"
```

---

### Task 4: Verify Live Integration And Guard Existing Cache Behavior

**Files:**
- Modify: `frontend/src/chart/projectors/pastCachedProjector.test.ts`
- No production files unless the focused test reveals an actual cache mismatch

**Interfaces:**
- Consumes: Task 2 and Task 3 projector behavior
- Produces: regression coverage that actual pane `data` functions still behave for normal `RangeBundle` usage

- [ ] **Step 1: Add an integration-style cache regression test**

If `QUOTE_TOTALS_SPEC` is not imported at the top of `frontend/src/chart/projectors/pastCachedProjector.test.ts`, update the existing quoteTotals import to include it:

```ts
import { projectBid, projectBidPoints, projectAsk, projectAskPoints, QUOTE_TOTALS_SPEC } from './quoteTotals';
```

Append this test block near the other quote totals cache/projector equivalence tests:

```ts
describe('hoga gap sentinels through cached projector specs', () => {
  const minute = 60_000;
  const open = 1_779_926_400_000;
  const axis = createVirtualAxis([
    { date: '20260528', sessionOpenMs: open, sessionCloseMs: open + 23_400_000 },
  ]);

  const candle = (t: number) => ({ ts_ms: t, open: 1, high: 1, low: 1, close: 1, vol_a: 0, vol_b: 0 });
  const point = (t: number, bid: number, ask: number) => ({
    t,
    bid_total: bid,
    ask_total: ask,
    bid_max: bid,
    ask_max: ask,
    imb_max_bid: bid,
    imb_max_ask: ask,
  });

  it('QUOTE_TOTALS_SPEC data functions hide candle-only hoga gaps without mutating the bundle points', () => {
    const bundle: any = {
      bucket_ms: minute,
      segments: [
        { date: '20260528', session_open_ms: open, session_close_ms: open + 23_400_000, source: 'kis_live' },
      ],
      candles: [candle(open), candle(open + minute), candle(open + 2 * minute)],
      quote_ratio: {
        points: [point(open, 10, 20), point(open + 2 * minute, 30, 40)],
      },
    };
    const ctx = { auctionMask: false, intraMax: false, surgeEnabled: false, surgeApproachPct: 95, surgeRearmPct: 85, surgeStartHHMM: 900 };

    expect(QUOTE_TOTALS_SPEC.series[0].data(bundle, axis, ctx)).toEqual([
      { time: 0, value: 10, color: 'rgba(0,0,0,0)' },
      { time: 60, value: 0, color: 'rgba(0,0,0,0)' },
      { time: 120, value: 30 },
    ]);
    expect(QUOTE_TOTALS_SPEC.series[1].data(bundle, axis, ctx)).toEqual([
      { time: 0, value: 20, color: 'rgba(0,0,0,0)' },
      { time: 60, value: 0, color: 'rgba(0,0,0,0)' },
      { time: 120, value: 40 },
    ]);
    expect(bundle.quote_ratio.points).toEqual([point(open, 10, 20), point(open + 2 * minute, 30, 40)]);
  });
});
```

- [ ] **Step 2: Run the cache/projector regression test**

Run:

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops/frontend
npm test -- src/chart/projectors/pastCachedProjector.test.ts --runInBand
```

Expected: PASS. If this fails with duplicate imports, merge imports as described in Step 1 and rerun.

- [ ] **Step 3: Run focused frontend tests**

Run:

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops/frontend
npm test -- src/chart/util/hogaGapHide.test.ts src/chart/projectors/quoteTotals.test.ts src/chart/projectors/ratio.test.ts src/chart/projectors/pastCachedProjector.test.ts src/live/bucketHogaSeries.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 4: Run typecheck or the repo's frontend validation command**

First inspect `frontend/package.json`:

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops/frontend
cat package.json
```

If `scripts.typecheck` exists, run:

```bash
npm run typecheck
```

Expected: PASS with no TypeScript errors.

If there is no `typecheck` script but `scripts.build` exists, run:

```bash
npm run build
```

Expected: PASS with a successful Vite/TypeScript build.

- [ ] **Step 5: Commit**

```bash
cd /home/dev/.codex/worktrees/2d82/hoga-ops
git add frontend/src/chart/projectors/pastCachedProjector.test.ts
git commit -m "test: guard hoga gap projector behavior"
```

---

## Manual QA

After all tasks pass:

- [ ] Start the app using the existing project command from `README.md` or `frontend/package.json`.
- [ ] Open `/live`.
- [ ] Select a symbol/date range where KIS candles exist but hoga/orderbook data is missing for at least one visible candle span.
- [ ] Enable 총잔량 and 호가비 panes.
- [ ] Confirm the candle pane remains visible through the gap.
- [ ] Confirm 총잔량 and 호가비 do not draw diagonal connectors across the missing-hoga span.
- [ ] Confirm a normal continuous hoga span still draws bid/ask totals and ratio normally.
- [ ] Confirm the closing auction mask still hides the 15:20-15:30 KST window as before.

## Self-Review

**Spec coverage:** The plan covers missing hoga data gaps by injecting transparent sentinels in the projection layer, covers both 총잔량 and 호가비, preserves the existing 3-level auction behavior, and avoids backend/API changes.

**Placeholder scan:** The plan avoids deferred-work markers, vague validation instructions, copy-by-reference task wording, and underspecified test requests. Each code-changing step includes exact code or exact insertion instructions.

**Type consistency:** `HogaGapPoint`, `isSyntheticHogaGapPoint`, and `withHogaGapSentinels` signatures are defined once in Task 1 and reused consistently in Tasks 2 and 3. The synthetic marker property is `__syntheticHogaGap` everywhere.
