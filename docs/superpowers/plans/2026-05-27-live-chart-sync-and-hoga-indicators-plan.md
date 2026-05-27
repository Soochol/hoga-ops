---
scope: both
spec: docs/superpowers/specs/2026-05-27-live-chart-sync-and-hoga-indicators-design.md
---

# /live Chart Sync + Historical Lazy Fetch + Hoga Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/live`'s three independent chart instances with one chart that shares timeScale across candle/volume/3 hoga indicator panes, add lazy-fetch of past data through the existing `/api/range`, and fix the hoga indicators by bucketing SSE events to the current timeframe.

**Architecture:** Frontend-only change for the visible work; one tiny backend fix (`/api/range` returns empty bundle instead of 404 when no captured stock-date exists). New module `buildLiveBundle.ts` converts the (SSE buffer, candle hook, `/api/range`) tuple into a single `RangeBundle` that the existing `/replay` `RangeSeriesPane` + `PANE_SPECS` + projectors render verbatim.

**Tech Stack:** React 18, TanStack Query, Zustand, lightweight-charts v5, Vitest. Backend: FastAPI, Pydantic, pytest.

**Domain terms (CONTEXT.md, no substitution):** Stock-Date, Regular Session, Auction Window, Quote Totals, 호가비, FillStrength, Source (`hogaplay` / `kis_live`), VirtualAxis.

---

## File Map

**New files (frontend):**
- `frontend/src/live/bucketHogaSeries.ts` — pure bucket function: raw SSE ob/trade events → `QuoteRatioPoint[]` + `FillStrengthPoint[]`
- `frontend/src/live/bucketHogaSeries.test.ts`
- `frontend/src/live/buildLiveBundle.ts` — assembles a merged `RangeBundle` from today's SSE buffer + `useLiveCandles` + past `useRange` response
- `frontend/src/live/buildLiveBundle.test.ts`
- `frontend/src/live/useLiveBundle.ts` — orchestrating hook that wires `useLiveSeries` + `useLiveCandles` + `useRange` + `buildLiveBundle`
- `frontend/src/live/useLiveBundle.test.tsx`
- `frontend/src/live/LiveChartRoot.tsx` — single `createChart` instance, mounts `PANE_SPECS` 0–4 through `RangeSeriesPane`, owns `subscribeVisibleTimeRangeChange` for lazy fetch trigger
- `frontend/src/live/LiveChartRoot.test.tsx`

**Modified files (frontend):**
- `frontend/src/live/LiveWorkarea.tsx` — three pane children → one `LiveChartRoot`
- `frontend/src/state/livePage.ts` — add `historicalFromDate` state (the earliest stock-date the user has scrolled to) and an `extendHistoricalRange(date)` action
- `frontend/src/api/range.ts` — handle empty-bundle response (after backend fix in Task 12); add tolerance for `RangeBundle` with empty segments

**Deleted files (frontend):**
- `frontend/src/live/LiveCandlePane.tsx`
- `frontend/src/live/LiveCandlePane.test.tsx`
- `frontend/src/live/LiveVolumePane.tsx`
- `frontend/src/live/LiveIndicatorPane.tsx`
- `frontend/src/live/LiveIndicatorPane.test.tsx`

**Modified files (backend):**
- `hoga/api/bundle.py` — replace the `no captured Stock-Date for code=… in […, …]` 404 with an empty `RangeBundle` response (segments=[], series=[]). Keep raising for malformed inputs.
- `hoga/tests/api/test_range_route.py` (or similar — discover during Task 12)

---

## Task 1: bucketHogaSeries — pure function with tests

**Files:**
- Create: `frontend/src/live/bucketHogaSeries.ts`
- Create: `frontend/src/live/bucketHogaSeries.test.ts`

This pure function takes raw SSE ob/trade snapshots and a `bucketMs`, returns the same shape projectors expect (`QuoteRatioPoint[]` and `FillStrengthPoint[]`). Quote Totals = last ob in bucket; FillStrength = sum of trade qty by side in bucket; empty buckets are omitted (no zero-padding).

- [ ] **Step 1.1: Write the failing tests**

```ts
// frontend/src/live/bucketHogaSeries.test.ts
import { describe, it, expect } from 'vitest';
import { bucketHogaSeries } from './bucketHogaSeries';

describe('bucketHogaSeries', () => {
  it('returns empty arrays for empty input', () => {
    const out = bucketHogaSeries([], [], 60_000);
    expect(out.quoteRatioPoints).toEqual([]);
    expect(out.fillStrengthPoints).toEqual([]);
  });

  it('Quote Totals uses last ob snapshot in each bucket', () => {
    // Two snapshots in same 60s bucket; later one wins.
    const ob = [
      { t_ms: 1700_000_000_000, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: 1700_000_000_010, total_ask_qty: 200, total_bid_qty: 90 }, // +10s
      { t_ms: 1700_000_000_070, total_ask_qty: 300, total_bid_qty: 95 }, // next bucket
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    // 1700_000_000_000 floored to 60_000 grid:
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    const b1 = Math.floor(1700_000_000_070 / 60_000) * 60_000;
    expect(quoteRatioPoints).toEqual([
      { t: b0, ask_total: 200, bid_total: 90 },
      { t: b1, ask_total: 300, bid_total: 95 },
    ]);
  });

  it('FillStrength sums buy/sell qty by side in each bucket', () => {
    // KIS side enum: -1=sell, 0=mid (skip), 1=buy, 2=auction (skip).
    const trade = [
      {
        t_ms: 1700_000_000_000,
        trades: [
          { side: 1, qty: 10 },
          { side: -1, qty: 4 },
          { side: 0, qty: 99 }, // mid — must NOT count
          { side: 2, qty: 50 }, // auction — must NOT count
        ],
      },
      {
        t_ms: 1700_000_000_010,
        trades: [{ side: 1, qty: 5 }],
      },
      {
        t_ms: 1700_000_000_070,
        trades: [{ side: -1, qty: 7 }],
      },
    ];
    const { fillStrengthPoints } = bucketHogaSeries([], trade, 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    const b1 = Math.floor(1700_000_000_070 / 60_000) * 60_000;
    expect(fillStrengthPoints).toEqual([
      { t: b0, buy_qty: 15, sell_qty: 4 },
      { t: b1, buy_qty: 0, sell_qty: 7 },
    ]);
  });

  it('omits empty buckets (no zero-padding)', () => {
    // ob in bucket 0, gap, ob in bucket 5 → only 2 points, no fill in between.
    const ob = [
      { t_ms: 1700_000_000_000, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: 1700_000_000_300, total_ask_qty: 200, total_bid_qty: 90 },
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    expect(quoteRatioPoints.length).toBe(2);
    expect(quoteRatioPoints[1].t - quoteRatioPoints[0].t).toBe(300_000);
  });

  it('out-of-order input is sorted before bucketing', () => {
    const ob = [
      { t_ms: 1700_000_000_070, total_ask_qty: 300, total_bid_qty: 95 },
      { t_ms: 1700_000_000_000, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: 1700_000_000_010, total_ask_qty: 200, total_bid_qty: 90 },
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    const b1 = Math.floor(1700_000_000_070 / 60_000) * 60_000;
    expect(quoteRatioPoints).toEqual([
      { t: b0, ask_total: 200, bid_total: 90 },
      { t: b1, ask_total: 300, bid_total: 95 },
    ]);
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/live/bucketHogaSeries.test.ts`
Expected: FAIL — `bucketHogaSeries is not defined`.

- [ ] **Step 1.3: Implement bucketHogaSeries**

```ts
// frontend/src/live/bucketHogaSeries.ts
import type { QuoteRatioPoint, FillStrengthPoint } from '../api/types';

export interface ObSnapshot {
  t_ms: number;
  total_ask_qty: number;
  total_bid_qty: number;
}

export interface TradeEvent {
  side: number; // KIS enum: -1 sell, 0 mid, 1 buy, 2 auction
  qty: number;
}

export interface TradeSnapshot {
  t_ms: number;
  trades: TradeEvent[];
}

/** Bucket label = floor(t_ms / bucketMs) * bucketMs (bucket start). Matches
 * `aggregateCandles.ts` convention so candle/volume/호가 align on the x-axis.
 *
 * Quote Totals: state — last snapshot in bucket wins (analogous to candle close).
 * FillStrength: flow — sum qty in bucket. Only side=1 (buy) and side=-1 (sell)
 * contribute. side=0 (mid, classifier fallback) and side=2 (auction) are
 * intentionally excluded — same semantics as ADR-0029's auction-window hide
 * and the replay viewer's existing FillStrength projector. */
export function bucketHogaSeries(
  ob: ObSnapshot[],
  trade: TradeSnapshot[],
  bucketMs: number,
): { quoteRatioPoints: QuoteRatioPoint[]; fillStrengthPoints: FillStrengthPoint[] } {
  if (bucketMs <= 0) throw new Error(`bucketMs must be positive, got ${bucketMs}`);

  // Quote Totals — last-in-bucket.
  const obSorted = [...ob].sort((a, b) => a.t_ms - b.t_ms);
  const quoteByBucket = new Map<number, QuoteRatioPoint>();
  for (const s of obSorted) {
    const t = Math.floor(s.t_ms / bucketMs) * bucketMs;
    quoteByBucket.set(t, { t, ask_total: s.total_ask_qty, bid_total: s.total_bid_qty });
  }
  const quoteRatioPoints = Array.from(quoteByBucket.values()).sort((a, b) => a.t - b.t);

  // FillStrength — sum-in-bucket.
  const tradeSorted = [...trade].sort((a, b) => a.t_ms - b.t_ms);
  const fillByBucket = new Map<number, FillStrengthPoint>();
  for (const s of tradeSorted) {
    const t = Math.floor(s.t_ms / bucketMs) * bucketMs;
    let bucket = fillByBucket.get(t);
    if (!bucket) {
      bucket = { t, buy_qty: 0, sell_qty: 0 };
      fillByBucket.set(t, bucket);
    }
    for (const ev of s.trades) {
      if (ev.side === 1) bucket.buy_qty += ev.qty;
      else if (ev.side === -1) bucket.sell_qty += ev.qty;
    }
  }
  const fillStrengthPoints = Array.from(fillByBucket.values()).sort((a, b) => a.t - b.t);

  return { quoteRatioPoints, fillStrengthPoints };
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/live/bucketHogaSeries.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add frontend/src/live/bucketHogaSeries.ts frontend/src/live/bucketHogaSeries.test.ts
git commit -m "feat(live): bucketHogaSeries — bucket SSE ob/trade events to RangeBundle shape

Pure function used by buildLiveBundle (Task 2) to convert raw SSE events
into the QuoteRatioPoint[] / FillStrengthPoint[] shape /replay projectors
expect. State-quantities (Quote Totals) use last-in-bucket; flow-quantities
(FillStrength) sum-in-bucket. side=0/2 trades are excluded matching the
existing replay projector semantics."
```

---

## Task 2: buildLiveBundle — assemble merged RangeBundle

**Files:**
- Create: `frontend/src/live/buildLiveBundle.ts`
- Create: `frontend/src/live/buildLiveBundle.test.ts`

This module takes (today's SSE buffer state, today's aggregated candles, optional past `RangeBundle`, today's session metadata, current `bucketMs`) and returns a single `RangeBundle` ready to hand to `RangeSeriesPane`. Resolves today's source per spec Section 2's "오늘 자 segment 해소 규칙" — promoted past wins if it covers today, otherwise SSE buffer fills in.

- [ ] **Step 2.1: Write the failing tests**

```ts
// frontend/src/live/buildLiveBundle.test.ts
import { describe, it, expect } from 'vitest';
import { buildLiveBundle } from './buildLiveBundle';
import type { RangeBundle, Candle } from '../api/types';

const TODAY = '20260527';
const TODAY_OPEN = Date.UTC(2026, 4, 27, 0, 0, 0); // 2026-05-27T00:00:00 UTC = 09:00 KST
const TODAY_CLOSE = TODAY_OPEN + 6.5 * 3600 * 1000; // 15:30 KST

function emptyRangeBundle(overrides: Partial<RangeBundle> = {}): RangeBundle {
  return {
    code: '005930',
    from_date: TODAY,
    to_date: TODAY,
    bucket_ms: 60_000,
    segments: [],
    candles: [],
    quote_ratio: { bucket_ms: 60_000, points: [] },
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { price_min: 0, price_max: 0, price_step: 1, bin_count: 0, bins: [] } as any,
    volume_profile_by_day: [],
    ...overrides,
  };
}

describe('buildLiveBundle', () => {
  it('empty inputs → empty bundle', () => {
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: null,
      sseOb: [],
      sseTrade: [],
      todayCandles: [],
      bucketMs: 60_000,
    });
    expect(bundle.segments).toEqual([]);
    expect(bundle.candles).toEqual([]);
    expect(bundle.quote_ratio.points).toEqual([]);
    expect(bundle.fill_strength.points).toEqual([]);
  });

  it('today-only: SSE + candles produce a single today segment tagged kis_live', () => {
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: null,
      sseOb: [
        { t_ms: TODAY_OPEN + 60_000, total_ask_qty: 100, total_bid_qty: 80 },
      ],
      sseTrade: [
        { t_ms: TODAY_OPEN + 60_000, trades: [{ side: 1, qty: 10 }] },
      ],
      todayCandles: [
        { t_ms: TODAY_OPEN, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
      ],
      bucketMs: 60_000,
    });
    expect(bundle.segments).toEqual([
      { date: TODAY, session_open_ms: TODAY_OPEN, session_close_ms: TODAY_CLOSE, source: 'kis_live' },
    ]);
    expect(bundle.candles).toEqual([
      { ts_ms: TODAY_OPEN, open: 70000, close: 70050, high: 70100, low: 69900, vol_a: 1000, vol_b: 0 },
    ]);
    expect(bundle.quote_ratio.points.length).toBe(1);
    expect(bundle.fill_strength.points.length).toBe(1);
    expect(bundle.bucket_ms).toBe(60_000);
  });

  it('past bundle includes today → SSE buffer is ignored', () => {
    // Spec Section 2 step 2: if /api/range already returned today (e.g.
    // post-promote hogaplay), live SSE buffer must not double-count.
    const past = emptyRangeBundle({
      segments: [
        { date: TODAY, session_open_ms: TODAY_OPEN, session_close_ms: TODAY_CLOSE, source: 'hogaplay' },
      ],
      candles: [
        { ts_ms: TODAY_OPEN, open: 70000, close: 70050, high: 70100, low: 69900, vol_a: 1000, vol_b: 0 },
      ],
      quote_ratio: { bucket_ms: 60_000, points: [{ t: TODAY_OPEN, ask_total: 500, bid_total: 500 }] },
      fill_strength: { bucket_ms: 60_000, points: [] },
    });
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: past,
      sseOb: [
        { t_ms: TODAY_OPEN, total_ask_qty: 999, total_bid_qty: 999 }, // would override if used
      ],
      sseTrade: [],
      todayCandles: [],
      bucketMs: 60_000,
    });
    expect(bundle.segments.length).toBe(1);
    expect(bundle.segments[0].source).toBe('hogaplay'); // past won
    expect(bundle.quote_ratio.points[0].ask_total).toBe(500); // SSE ignored
  });

  it('past-only with yesterday, SSE today → segments concatenated in date order', () => {
    const yesterday = '20260526';
    const Y_OPEN = TODAY_OPEN - 86400_000;
    const Y_CLOSE = Y_OPEN + 6.5 * 3600 * 1000;
    const past = emptyRangeBundle({
      segments: [
        { date: yesterday, session_open_ms: Y_OPEN, session_close_ms: Y_CLOSE, source: 'kis_live' },
      ],
      candles: [
        { ts_ms: Y_OPEN, open: 69000, close: 69500, high: 69600, low: 68900, vol_a: 800, vol_b: 0 },
      ],
    });
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: past,
      sseOb: [{ t_ms: TODAY_OPEN, total_ask_qty: 100, total_bid_qty: 80 }],
      sseTrade: [],
      todayCandles: [
        { t_ms: TODAY_OPEN, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
      ],
      bucketMs: 60_000,
    });
    expect(bundle.segments.map((s) => s.date)).toEqual([yesterday, TODAY]);
    expect(bundle.candles.map((c) => c.ts_ms)).toEqual([Y_OPEN, TODAY_OPEN]);
  });

  it('past bundle with empty segments (backend empty-no-data response) → treated like null', () => {
    const past = emptyRangeBundle({ segments: [] });
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: past,
      sseOb: [{ t_ms: TODAY_OPEN, total_ask_qty: 100, total_bid_qty: 80 }],
      sseTrade: [],
      todayCandles: [],
      bucketMs: 60_000,
    });
    expect(bundle.segments[0].source).toBe('kis_live');
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/live/buildLiveBundle.test.ts`
Expected: FAIL — `buildLiveBundle is not defined`.

- [ ] **Step 2.3: Implement buildLiveBundle**

```ts
// frontend/src/live/buildLiveBundle.ts
import type { RangeBundle, RangeSegment, Candle } from '../api/types';
import type { LiveCandle } from '../api/liveCandles';
import {
  bucketHogaSeries,
  type ObSnapshot,
  type TradeSnapshot,
} from './bucketHogaSeries';

export interface BuildLiveBundleInput {
  code: string;
  todayDate: string;
  todaySession: { open_ms: number; close_ms: number };
  /** Past stock-dates fetched via /api/range. null when no fetch has happened
   * yet or the request returned empty. */
  pastBundle: RangeBundle | null;
  sseOb: ObSnapshot[];
  sseTrade: TradeSnapshot[];
  /** Today's candles from useLiveCandles (already client-side aggregated to
   * the display timeframe). */
  todayCandles: LiveCandle[];
  bucketMs: number;
}

/** Spec Section 2 — assemble a merged RangeBundle by stitching the past
 * bundle (from /api/range) and today's live state (SSE buffer + candle hook).
 *
 * Today segment resolution (Section 2 step 1-4):
 *   - If pastBundle.segments includes today → use that (promoted Parquet won;
 *     SSE buffer is intentionally ignored to avoid double-counting).
 *   - Else if SSE buffer + candles have anything → build today segment from
 *     them, tagged source='kis_live'.
 *   - Else → no today segment (chart shows today as empty).
 */
export function buildLiveBundle(input: BuildLiveBundleInput): RangeBundle {
  const {
    code,
    todayDate,
    todaySession,
    pastBundle,
    sseOb,
    sseTrade,
    todayCandles,
    bucketMs,
  } = input;

  const pastSegments = pastBundle?.segments ?? [];
  const pastHasToday = pastSegments.some((s) => s.date === todayDate);

  // ----- Today segment -----
  const todaySegments: RangeSegment[] = [];
  const todayCandlesRow: Candle[] = [];
  const todayQuotePoints = pastHasToday ? [] : bucketHogaSeries(sseOb, sseTrade, bucketMs).quoteRatioPoints;
  const todayFillPoints = pastHasToday ? [] : bucketHogaSeries(sseOb, sseTrade, bucketMs).fillStrengthPoints;

  if (!pastHasToday) {
    const hasAnyData =
      sseOb.length > 0 || sseTrade.length > 0 || todayCandles.length > 0;
    if (hasAnyData) {
      todaySegments.push({
        date: todayDate,
        session_open_ms: todaySession.open_ms,
        session_close_ms: todaySession.close_ms,
        source: 'kis_live',
      });
      for (const c of todayCandles) {
        todayCandlesRow.push({
          ts_ms: c.t_ms,
          open: c.open,
          close: c.close,
          high: c.high,
          low: c.low,
          vol_a: c.volume, // entire volume into vol_a (projector reads vol_a + vol_b)
          vol_b: 0,
        });
      }
    }
  }

  // ----- Merge -----
  const pastFromDate = pastBundle?.from_date ?? todayDate;
  const segments = [...pastSegments, ...todaySegments];
  const candles = [...(pastBundle?.candles ?? []), ...todayCandlesRow];
  const quoteRatioPoints = [...(pastBundle?.quote_ratio.points ?? []), ...todayQuotePoints];
  const fillStrengthPoints = [...(pastBundle?.fill_strength.points ?? []), ...todayFillPoints];

  return {
    code,
    from_date: pastFromDate,
    to_date: todayDate,
    bucket_ms: bucketMs,
    segments,
    candles,
    quote_ratio: { bucket_ms: bucketMs, points: quoteRatioPoints },
    fill_strength: { bucket_ms: bucketMs, points: fillStrengthPoints },
    // /live doesn't compute volume profile — feed empty placeholders matching
    // the type. /replay's VolumeProfileOverlay isn't mounted on /live so these
    // are never read.
    volume_profile_range: {
      price_min: 0,
      price_max: 0,
      price_step: 1,
      bin_count: 0,
      bins: [],
    } as any,
    volume_profile_by_day: [],
    excluded_dates: pastBundle?.excluded_dates,
    data_warnings: pastBundle?.data_warnings,
  };
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/live/buildLiveBundle.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add frontend/src/live/buildLiveBundle.ts frontend/src/live/buildLiveBundle.test.ts
git commit -m "feat(live): buildLiveBundle — merge SSE buffer + /api/range into one RangeBundle

Implements spec Section 2's today-segment resolution rules: promoted past wins
over SSE buffer when both cover today (avoids double-count post-promote);
otherwise SSE buffer fills today with source='kis_live'. Past segments and
today segment are stitched in date order so VirtualAxis + projectors can
treat the result as a normal multi-day RangeBundle."
```

---

## Task 3: useLiveBundle — orchestrating hook

**Files:**
- Create: `frontend/src/live/useLiveBundle.ts`
- Create: `frontend/src/live/useLiveBundle.test.tsx`

Combines `useLiveSeries` (SSE), `useLiveCandles` (today candles), and `useRange` (past data) into one merged `RangeBundle` via `buildLiveBundle`. Reads `historicalFromDate` from `useLivePageStore` and `sourcePreference` from `useSourcePreferenceStore`.

- [ ] **Step 3.1: Add historical-range state to livePage store**

Edit `frontend/src/state/livePage.ts`:

```ts
// Add to Persisted type:
//   historicalFromDate: string | null;  // YYYYMMDD, earliest date user has scrolled to
// Add to Store type:
//   extendHistoricalRange: (date: string) => void;
//   resetHistoricalRange: () => void;
```

Concrete edit — open `frontend/src/state/livePage.ts` and apply:

```ts
type Persisted = {
  activeCode: string | null;
  candleTimeframe: LiveTimeframe;
  watchlistPanelOpen: boolean;
  /** Earliest stock-date the user has scrolled into (YYYYMMDD). null = today
   * only (no /api/range call needed yet). Resets when activeCode or timeframe
   * changes. */
  historicalFromDate: string | null;
};

type Store = Persisted & {
  setActiveCode: (code: string | null) => void;
  setCandleTimeframe: (tf: LiveTimeframe) => void;
  toggleWatchlistPanel: () => void;
  setWatchlistPanelOpen: (open: boolean) => void;
  extendHistoricalRange: (date: string) => void;
  resetHistoricalRange: () => void;
  hydrateFromStorage: () => void;
};

const DEFAULTS: Persisted = {
  activeCode: null,
  candleTimeframe: '1m',
  watchlistPanelOpen: false,
  historicalFromDate: null,
};
```

Then add inside the `create<Store>((set, get) => ({` body:

```ts
  extendHistoricalRange: (date) => {
    const cur = get().historicalFromDate;
    if (cur !== null && cur <= date) return; // already at or before this date
    set({ historicalFromDate: date });
    persist({ ...get(), historicalFromDate: date });
  },

  resetHistoricalRange: () => {
    set({ historicalFromDate: null });
    persist({ ...get(), historicalFromDate: null });
  },
```

Also: in both `setActiveCode` and `setCandleTimeframe`, after the existing
`set(...)`, add `set({ historicalFromDate: null }); persist({ ...get(), historicalFromDate: null });`
so changing the code/timeframe wipes the range (lazy fetch restarts).

- [ ] **Step 3.2: Write useLiveBundle tests**

```tsx
// frontend/src/live/useLiveBundle.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLiveBundle } from './useLiveBundle';
import { useLivePageStore } from '../state/livePage';
import { useSourcePreferenceStore } from '../state/sourcePreference';

vi.mock('../api/liveSeries', () => ({
  useLiveSeries: () => ({
    initial: { session_open_ms: 1748275200000, session_close_ms: 1748298600000 },
    isLoading: false,
    error: null,
    ob: [
      { t_ms: 1748275260000, total_ask_qty: 100, total_bid_qty: 80, kind: 'ob' },
    ],
    trade: [],
    broker: [],
  }),
}));

vi.mock('../api/liveCandles', () => ({
  useLiveCandles: () => ({
    candles: [
      { t_ms: 1748275200000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
    ],
  }),
}));

vi.mock('../api/range', () => ({
  useRange: () => ({ data: null, isLoading: false, error: null }),
}));

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe('useLiveBundle', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: null,
    });
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_live' });
  });

  it('builds a today-only bundle when historicalFromDate is null', () => {
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527'), { wrapper });
    expect(result.current.bundle.segments.length).toBe(1);
    expect(result.current.bundle.segments[0].source).toBe('kis_live');
    expect(result.current.bundle.candles.length).toBe(1);
    expect(result.current.bundle.quote_ratio.points.length).toBe(1);
  });

  it('returns null bundle when code is null', () => {
    const { result } = renderHook(() => useLiveBundle(null, '1m', '20260527'), { wrapper });
    expect(result.current.bundle).toBeNull();
  });
});
```

- [ ] **Step 3.3: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/live/useLiveBundle.test.tsx`
Expected: FAIL — `useLiveBundle is not defined`.

- [ ] **Step 3.4: Implement useLiveBundle**

```ts
// frontend/src/live/useLiveBundle.ts
import { useMemo } from 'react';
import { useLiveSeries } from '../api/liveSeries';
import { useLiveCandles } from '../api/liveCandles';
import { useRange } from '../api/range';
import { useLivePageStore, bucketSeconds, type LiveTimeframe } from '../state/livePage';
import { TIMEFRAME_TO_MS, type Timeframe } from '../api/types';
import { buildLiveBundle } from './buildLiveBundle';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import type { RangeBundle } from '../api/types';

const MINUTE_TIMEFRAMES: ReadonlyArray<Timeframe> = ['1m', '3m', '5m', '10m', '15m', '30m'];

function isMinuteTimeframe(tf: LiveTimeframe): tf is Timeframe {
  return (MINUTE_TIMEFRAMES as ReadonlyArray<string>).includes(tf);
}

/** Yesterday in YYYYMMDD KST given today YYYYMMDD KST. */
function yesterdayKst(todayYyyymmdd: string): string {
  const y = parseInt(todayYyyymmdd.slice(0, 4), 10);
  const m = parseInt(todayYyyymmdd.slice(4, 6), 10);
  const d = parseInt(todayYyyymmdd.slice(6, 8), 10);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export interface UseLiveBundleResult {
  bundle: RangeBundle | null;
  isLoading: boolean;
  error: unknown;
}

/** Orchestrate live SSE + today candles + past /api/range into a single
 * RangeBundle for LiveChartRoot.
 *
 * - Minute timeframes (1m–30m): full pipeline including past lazy fetch.
 * - D/W/M: SSE-disabled, hoga indicators stay empty (Addendum 9.4).
 */
export function useLiveBundle(
  code: string | null,
  timeframe: LiveTimeframe,
  todayKstYyyymmdd: string,
): UseLiveBundleResult {
  const historicalFromDate = useLivePageStore((s) => s.historicalFromDate);

  const live = useLiveSeries(code ?? '');
  const { candles: todayCandles } = useLiveCandles(code ?? '', timeframe);

  const isMinute = isMinuteTimeframe(timeframe);
  const bucketMs = isMinute ? TIMEFRAME_TO_MS[timeframe] : 60_000;

  // /api/range — only call when we have a historical range AND timeframe is
  // a minute frame. D/W/M skip past fetch entirely (spec Section 4.2).
  const pastTo = yesterdayKst(todayKstYyyymmdd);
  const enableRange = !!(code && historicalFromDate && isMinute && historicalFromDate <= pastTo);
  const past = useRange(
    enableRange ? code : null,
    enableRange ? historicalFromDate : null,
    enableRange ? pastTo : null,
    enableRange && isMinute ? (timeframe as Timeframe) : null,
  );

  const bundle = useMemo<RangeBundle | null>(() => {
    if (!code) return null;

    const todaySession =
      live.initial != null
        ? { open_ms: live.initial.session_open_ms, close_ms: live.initial.session_close_ms ?? regularSessionCloseMs(todayKstYyyymmdd) }
        : { open_ms: regularSessionOpenMs(todayKstYyyymmdd), close_ms: regularSessionCloseMs(todayKstYyyymmdd) };

    // D/W/M: hoga indicators are intentionally empty per Addendum 9.4.
    const sseOb = isMinute ? (live.ob as unknown as ObSnapshot[]) : [];
    const sseTrade = isMinute ? (live.trade as unknown as TradeSnapshot[]) : [];

    return buildLiveBundle({
      code,
      todayDate: todayKstYyyymmdd,
      todaySession,
      pastBundle: past.data ?? null,
      sseOb,
      sseTrade,
      todayCandles,
      bucketMs,
    });
  }, [code, todayKstYyyymmdd, isMinute, live.initial, live.ob, live.trade, past.data, todayCandles, bucketMs]);

  return {
    bundle,
    isLoading: live.isLoading || past.isLoading,
    error: live.error ?? past.error ?? null,
  };
}

/** Fallback session bounds for today when /api/live/series hasn't responded
 * yet — 09:00 KST open, 15:30 KST close. KRX Half-Day Sessions render with
 * these defaults until live.initial arrives (acceptable per spec §2). */
function regularSessionOpenMs(yyyymmdd: string): number {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  // 09:00 KST = 00:00 UTC
  return Date.UTC(y, m - 1, d, 0, 0, 0);
}

function regularSessionCloseMs(yyyymmdd: string): number {
  // 15:30 KST = 06:30 UTC
  return regularSessionOpenMs(yyyymmdd) + 6.5 * 3600 * 1000;
}
```

- [ ] **Step 3.5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/live/useLiveBundle.test.tsx`
Expected: PASS — 2 tests pass.

- [ ] **Step 3.6: Commit**

```bash
git add frontend/src/state/livePage.ts \
        frontend/src/live/useLiveBundle.ts \
        frontend/src/live/useLiveBundle.test.tsx
git commit -m "feat(live): useLiveBundle hook + historicalFromDate store field

Orchestrates useLiveSeries + useLiveCandles + useRange into a single
RangeBundle through buildLiveBundle. historicalFromDate tracks the
earliest stock-date the user has lazy-fetched; resets on activeCode
or timeframe change."
```

---

## Task 4: LiveChartRoot — single chart with PANE_SPECS

**Files:**
- Create: `frontend/src/live/LiveChartRoot.tsx`
- Create: `frontend/src/live/LiveChartRoot.test.tsx`

A simplified `ChartStage` for `/live`: one `createChart`, mounts the 5 `PANE_SPECS` through `RangeSeriesPane`, wires `subscribeVisibleTimeRangeChange` to trigger lazy fetch by calling `useLivePageStore.extendHistoricalRange`. **Does not** mount `DrawingOverlay`, `VolumeProfileOverlay`, `AuctionWindowOverlay` (Non-goals).

- [ ] **Step 4.1: Write the failing tests**

```tsx
// frontend/src/live/LiveChartRoot.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { LiveChartRoot } from './LiveChartRoot';

// lightweight-charts is hard to mount in jsdom; the existing
// LiveCandlePane.test.tsx mocks it. Reuse that pattern.
vi.mock('lightweight-charts', async () => {
  const mod = await vi.importActual<typeof import('lightweight-charts')>('lightweight-charts');
  return {
    ...mod,
    createChart: vi.fn(() => ({
      addSeries: vi.fn(() => ({ setData: vi.fn(), removeSeries: vi.fn() })),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ({
        subscribeVisibleTimeRangeChange: vi.fn(),
        unsubscribeVisibleTimeRangeChange: vi.fn(),
        applyOptions: vi.fn(),
        fitContent: vi.fn(),
        scrollToRealTime: vi.fn(),
      })),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    })),
  };
});

vi.mock('./useLiveBundle', () => ({
  useLiveBundle: () => ({
    bundle: {
      code: '005930',
      from_date: '20260527',
      to_date: '20260527',
      bucket_ms: 60_000,
      segments: [
        { date: '20260527', session_open_ms: 1748275200000, session_close_ms: 1748298600000, source: 'kis_live' },
      ],
      candles: [],
      quote_ratio: { bucket_ms: 60_000, points: [] },
      fill_strength: { bucket_ms: 60_000, points: [] },
      volume_profile_range: { price_min: 0, price_max: 0, price_step: 1, bin_count: 0, bins: [] },
      volume_profile_by_day: [],
    },
    isLoading: false,
    error: null,
  }),
}));

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe('LiveChartRoot', () => {
  it('renders root container with chart slot', () => {
    render(<LiveChartRoot code="005930" timeframe="1m" />, { wrapper });
    expect(screen.getByTestId('live-chart-root')).toBeTruthy();
  });

  it('shows D/W/M hoga indicator empty-state notice on D timeframe', () => {
    render(<LiveChartRoot code="005930" timeframe="D" />, { wrapper });
    expect(screen.getByTestId('indicator-disabled-note')).toBeTruthy();
  });

  it('hides D/W/M empty-state notice on minute timeframes', () => {
    render(<LiveChartRoot code="005930" timeframe="1m" />, { wrapper });
    expect(screen.queryByTestId('indicator-disabled-note')).toBeNull();
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx`
Expected: FAIL — `LiveChartRoot is not defined`.

- [ ] **Step 4.3: Implement LiveChartRoot**

```tsx
// frontend/src/live/LiveChartRoot.tsx
import { useEffect, useRef, useState } from 'react';
import { createChart, type IChartApi, type Time } from 'lightweight-charts';
import { resolveTokens } from '../util/tokens';
import {
  CHART_CROSSHAIR_OPTIONS,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';
import { createVirtualAxis } from '../util/virtualAxis';
import RangeSeriesPane from '../chart/RangeSeriesPane';
import { PANE_SPECS, PANE_STRETCH } from '../chart/paneSpecs';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';
import { useLiveBundle } from './useLiveBundle';

const TOKEN_SPEC = {
  bgCard: ['--bg-card', '#13131C'],
  fg: ['--fg', '#E2E8F0'],
  grid: ['--grid', '#1A1A26'],
  border: ['--border', '#1F1F2A'],
} as const;

function todayKstYyyymmdd(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function realMsToYyyymmdd(realMs: number): string {
  const kst = new Date(realMs + 9 * 3_600_000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

const MINUTE_TIMEFRAMES: ReadonlyArray<LiveTimeframe> = ['1m', '3m', '5m', '10m', '15m', '30m'];
function isMinuteTimeframe(tf: LiveTimeframe): boolean {
  return MINUTE_TIMEFRAMES.includes(tf);
}

interface Props {
  code: string | null;
  timeframe: LiveTimeframe;
}

/** /live's single-chart root. Mounts PANE_SPECS 0-4 inside one createChart
 * instance so timeScale is shared across candle/volume/3-hoga panes. */
export function LiveChartRoot({ code, timeframe }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);
  const today = todayKstYyyymmdd();

  const { bundle } = useLiveBundle(code, timeframe, today);
  const axis = bundle ? createVirtualAxis(
    bundle.segments.map((s) => ({
      date: s.date,
      sessionOpenMs: s.session_open_ms,
      sessionCloseMs: s.session_close_ms,
    })),
  ) : null;

  // Mount chart once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const tokens = resolveTokens(TOKEN_SPEC);
    const c = createChart(el, {
      ...CHART_LAYOUT_OPTIONS,
      width: el.clientWidth,
      height: el.clientHeight,
      layout: { background: { color: tokens.bgCard }, textColor: tokens.fg },
      grid: { vertLines: { color: tokens.grid }, horzLines: { color: tokens.grid } },
      timeScale: { ...CHART_TIMESCALE_OPTIONS, borderColor: tokens.border },
      crosshair: CHART_CROSSHAIR_OPTIONS,
      rightPriceScale: { borderColor: tokens.border },
      autoSize: true,
    });
    setChart(c);

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) c.resize(w, h);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      c.remove();
      setChart(null);
    };
  }, []);

  // Lazy fetch trigger — extend historicalFromDate when user scrolls left.
  useEffect(() => {
    if (!chart) return;
    const ts = chart.timeScale();
    const handler = (range: unknown) => {
      const r = range as { from?: Time | null } | null;
      if (!r || r.from == null) return;
      // r.from is virtual axis seconds; convert through axis if present.
      // Without axis we treat it as a plain unix-second (today-only case).
      const sec = r.from as number;
      const realMs = axis && axis.segments.length > 0 ? axis.toReal(sec * 1000) : sec * 1000;
      const date = realMsToYyyymmdd(realMs);
      // Only minute timeframes use historical lazy fetch.
      if (!isMinuteTimeframe(timeframe)) return;
      useLivePageStore.getState().extendHistoricalRange(date);
    };
    ts.subscribeVisibleTimeRangeChange(handler);
    return () => {
      ts.unsubscribeVisibleTimeRangeChange(handler);
    };
  }, [chart, axis, timeframe]);

  // Apply pane stretch factors after children mount panes.
  useEffect(() => {
    if (!chart || !bundle) return;
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      try {
        const panes = chart.panes();
        if (panes.length < PANE_STRETCH.length) {
          requestAnimationFrame(apply);
          return;
        }
        panes.forEach((p, i) => {
          const f = PANE_STRETCH[i];
          if (f !== undefined && typeof p.setStretchFactor === 'function') {
            p.setStretchFactor(f);
          }
        });
      } catch {
        // chart tearing down
      }
    };
    const raf = requestAnimationFrame(apply);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [chart, bundle]);

  const dwDisabled = !isMinuteTimeframe(timeframe);

  return (
    <div
      data-testid="live-chart-root"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', background: 'var(--bg-card)' }}
      />
      {chart && bundle && axis &&
        PANE_SPECS.map((spec, i) => (
          <RangeSeriesPane
            key={spec.name}
            chart={chart}
            bundle={bundle}
            axis={axis}
            paneIndex={i}
            spec={spec}
          />
        ))}
      {dwDisabled && (
        <div
          data-testid="indicator-disabled-note"
          style={{
            position: 'absolute',
            top: 'var(--space-md)',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: 'var(--space-xs) var(--space-md)',
            background: 'var(--bg-subtle)',
            color: 'var(--fg-dimmer)',
            fontSize: 'var(--text-xs)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            pointerEvents: 'none',
          }}
        >
          라이브 지표는 분봉에서 표시됩니다
        </div>
      )}
    </div>
  );
}

export default LiveChartRoot;
```

- [ ] **Step 4.4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx`
Expected: PASS — 3 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.test.tsx
git commit -m "feat(live): LiveChartRoot — single chart that reuses /replay's PANE_SPECS

Single createChart instance, mounts 5 RangeSeriesPane through PANE_SPECS.
Wires subscribeVisibleTimeRangeChange to extendHistoricalRange so panning
left triggers lazy fetch (Task 9). D/W/M timeframes show
\"라이브 지표는 분봉에서 표시됩니다\" overlay — projectors naturally render
empty series since pastBundle/SSE are empty in those frames."
```

---

## Task 5: Swap LiveWorkarea to use LiveChartRoot

**Files:**
- Modify: `frontend/src/live/LiveWorkarea.tsx`

The three independent pane components get replaced by one `LiveChartRoot`. Grid template stops being "3 rows" and becomes a single chart cell.

- [ ] **Step 5.1: Edit LiveWorkarea.tsx**

Open `frontend/src/live/LiveWorkarea.tsx`. Replace the three pane imports and their JSX with a single `LiveChartRoot`:

```tsx
import { useLivePageStore } from '../state/livePage';
import { LiveChartRoot } from './LiveChartRoot';
import { LiveEmptyState } from './LiveEmptyState';
import { LiveSidebar } from './LiveSidebar';
import { WatchlistPanel } from './WatchlistPanel';

interface Props {
  activeCode: string | null;
  watchlistEmpty: boolean;
}

export function LiveWorkarea({ activeCode, watchlistEmpty }: Props) {
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const watchlistOpen = useLivePageStore((s) => s.watchlistPanelOpen);

  if (watchlistEmpty) {
    return (
      <div data-testid="live-workarea" className="h-full">
        <LiveEmptyState cause="watchlist_empty" />
      </div>
    );
  }
  if (!activeCode) {
    return (
      <div data-testid="live-workarea" className="h-full flex">
        <div style={{ flex: 1 }}>
          <LiveEmptyState cause="no_active_code" />
        </div>
        {watchlistOpen && <WatchlistPanel />}
      </div>
    );
  }

  // Single chart owns all 5 panes; sidebar + optional watchlist stay siblings.
  return (
    <div
      data-testid="live-workarea"
      className="h-full flex"
      style={{
        background: 'var(--bg)',
        // minHeight: 0 + overflow: hidden close the runaway-chart-height
        // feedback loop (see 67c527a). The chart canvas's intrinsic size
        // would otherwise push the flex container's height.
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <LiveChartRoot code={activeCode} timeframe={timeframe} />
      </div>
      <div
        role="complementary"
        aria-label="Live Sidebar"
        style={{
          width: 'var(--sidebar-w)',
          flexShrink: 0,
          borderLeft: '1px solid var(--border)',
        }}
      >
        <LiveSidebar code={activeCode} />
      </div>
      {watchlistOpen && <WatchlistPanel />}
    </div>
  );
}
```

- [ ] **Step 5.2: Delete old pane components and their tests**

```bash
rm frontend/src/live/LiveCandlePane.tsx
rm frontend/src/live/LiveCandlePane.test.tsx
rm frontend/src/live/LiveVolumePane.tsx
rm frontend/src/live/LiveIndicatorPane.tsx
rm frontend/src/live/LiveIndicatorPane.test.tsx
```

- [ ] **Step 5.3: Run typecheck + test suite**

Run: `cd frontend && npm run build`
Expected: PASS — TypeScript compile + Vite build succeed.

Run: `cd frontend && npx vitest run src/live/`
Expected: PASS — all remaining `src/live/` tests pass.

If TypeScript flags a missing import elsewhere (a test file still referencing
the removed pane components), fix that file: either update the import to the
new LiveChartRoot or delete the obsolete test.

- [ ] **Step 5.4: Commit**

```bash
git add frontend/src/live/LiveWorkarea.tsx
git rm frontend/src/live/LiveCandlePane.tsx \
       frontend/src/live/LiveCandlePane.test.tsx \
       frontend/src/live/LiveVolumePane.tsx \
       frontend/src/live/LiveIndicatorPane.tsx \
       frontend/src/live/LiveIndicatorPane.test.tsx
git commit -m "refactor(live): replace three pane components with LiveChartRoot

LiveCandlePane / LiveVolumePane / LiveIndicatorPane each created their
own createChart() instance with independent timeScale. Replaced by a
single LiveChartRoot (Task 4) that shares one timeScale across 5 panes.
Closes problem 1 (timeScale sync) and the structural side of problem 3
(hoga indicators now bucket to the displayed timeframe)."
```

---

## Task 6: Manual QA after Phase 1 — confirm problems 1 and 3 are gone

**Files:** none (manual verification before continuing to Phase 2).

- [ ] **Step 6.1: Start backend and frontend dev servers**

Backend (separate terminal):
```bash
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

Frontend (separate terminal):
```bash
cd frontend && npm run dev
```

- [ ] **Step 6.2: Open http://localhost:5173/live in a browser**

Verify:
1. Page loads with one chart area containing 5 stacked panes (candle / volume / quote totals / 호가비 / fillstrength).
2. Panning the candle area left/right moves ALL panes together (the same x-axis labels visible across all 5).
3. Quote totals lines and 호가비 line render with the **same bucket grid** as the candle bars (i.e. one point per candle, not the previous dense per-second jitter).
4. FillStrength histogram bars line up with the candle/volume bars.
5. Switch timeframe to 5m → all panes rebucket together; switch to D → hoga panes become empty and the `라이브 지표는 분봉에서 표시됩니다` notice appears.

If any of (1)–(5) fails, the Step 1–4 implementation has a bug. Do NOT proceed past this step until verified.

- [ ] **Step 6.3: No commit (verification only)**

---

## Task 7: SSE payload sanity check (debugging hypothesis H1/H3)

**Files:** none — investigation only. Produces a one-line update to the spec's "디버깅 후보" section based on findings.

Spec Section 5 lists H1 (field name mismatch) and H3 (side enum mismatch) as candidate root causes. Cross-checking against [hoga/live/kis_client.py:252-253](../../hoga/live/kis_client.py#L252) shows the backend writes `total_ask_qty` / `total_bid_qty`, which is exactly what `bucketHogaSeries` reads — so **H1 is not the bug**. KIS `classify_side` returns `-1 / 0 / 1 / 2` ([kis_client.py:34-40](../../hoga/live/kis_client.py#L34)) where 1/-1 match `bucketHogaSeries`'s buy/sell counts and 0/2 are intentionally dropped (same as `/replay`'s FillStrength projector). So **H3 is not a bug either**. H2 is the cause; the bucketing introduced in Task 1 should resolve it. Confirm this by Task 6's manual QA.

- [ ] **Step 7.1: Update the spec's debug hypothesis section**

Open `docs/superpowers/specs/2026-05-27-live-chart-sync-and-hoga-indicators-design.md`. Inside Section 5 "디버깅 후보 (plan에서 검증)", replace the existing list with:

```markdown
**디버깅 후보 검증 결과 (plan/Task 7):**
- (H1) backend `KisOrderbook` exposes `total_ask_qty` / `total_bid_qty` ([hoga/live/kis_client.py:252-253](../../hoga/live/kis_client.py#L252)) — same names frontend already reads. **Not a bug.**
- (H2) Pre-spec frontend plotted raw second-level events on a minute-bucket chart, producing dense noise. **Fixed by Task 1's `bucketHogaSeries`.**
- (H3) KIS `classify_side` returns -1 / 0 / 1 / 2. `bucketHogaSeries` sums only 1 and -1, matching `/replay`'s FillStrength projector. **Not a bug.**
```

- [ ] **Step 7.2: Commit**

```bash
git add docs/superpowers/specs/2026-05-27-live-chart-sync-and-hoga-indicators-design.md
git commit -m "docs(spec): record debug hypothesis verification — H2 is the only true cause

After Phase 1 manual QA confirms hoga indicators render correctly, mark
H1 and H3 as cross-checked false alarms; H2 (no bucketing) is the cause,
already fixed by Task 1's bucketHogaSeries."
```

---

## Task 8: Backend — /api/range returns empty bundle on no-data

**Files:**
- Modify: `hoga/api/bundle.py:369` (the `no captured Stock-Date` ValueError)
- Modify: tests under `hoga/tests/api/` that assert the 404 (discover via grep)

Currently `/api/range` raises `ValueError("no captured Stock-Date for code=X in [from, to]")` when no promoted Parquet exists in the requested range. Spec Section 4.3 treats this case as normal for `/live` (today is fetched separately via SSE; past may be entirely missing). Replace the error with an empty `RangeBundle`.

- [ ] **Step 8.1: Locate the call site**

Run: `grep -n "no captured Stock-Date" hoga/api/bundle.py`
Expected: one match around line 369 inside `build_range_bundle`.

Run: `grep -rn "no captured Stock-Date\|no_captured" hoga/tests/`
Expected: zero or a small number of test assertions matching this string.

- [ ] **Step 8.2: Write a failing test for the new behaviour**

Identify the test file that exercises `/api/range` (look for `test_range`, `test_api_range`, or similar). Add a test that requests a range with NO captured stock-dates and asserts a 200 response with empty segments instead of a 404.

Example template — adapt the imports/fixtures to whatever the existing tests use:

```python
def test_api_range_no_data_returns_empty_bundle(test_client_with_empty_data_dir):
    """Spec 2026-05-27 §4.3: /live treats no-data as a normal case and
    expects an empty bundle, not a 404."""
    r = test_client_with_empty_data_dir.get(
        "/api/range?code=005930&from=20200101&to=20200107&bucket_ms=60000&source_pref=kis_live"
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["segments"] == []
    assert body["candles"] == []
    assert body["quote_ratio"]["points"] == []
    assert body["fill_strength"]["points"] == []
    assert body["code"] == "005930"
    assert body["from_date"] == "20200101"
    assert body["to_date"] == "20200107"
    assert body["bucket_ms"] == 60000
```

- [ ] **Step 8.3: Run the new test, expect FAIL**

Run: `uv run pytest -k "test_api_range_no_data_returns_empty_bundle" -x`
Expected: FAIL — currently raises and returns 404 / 500.

- [ ] **Step 8.4: Modify hoga/api/bundle.py**

Locate the block around line 369:

```python
if not stock_dates:
    raise ValueError(
        f"no captured Stock-Date for code={code} in [{from_date}, {to_date}]",
    )
```

Replace with an early return of an empty `RangeBundle`. The exact return shape must match the existing `RangeBundle` Pydantic model — read the surrounding code to find the constructor / dict shape used elsewhere in this function for the success path, and mirror it with empty lists.

```python
if not stock_dates:
    # Spec 2026-05-27: empty range is a normal case for /live's lazy fetch.
    # Surface it as an empty bundle so the frontend can stitch today's SSE
    # buffer in without round-tripping through 404 handling.
    return RangeBundle(
        code=code,
        from_date=from_date,
        to_date=to_date,
        bucket_ms=bucket_ms,
        segments=[],
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=[]),
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=[]),
        volume_profile_range=_empty_volume_profile(),
        volume_profile_by_day=[],
        excluded_dates=[],
        data_warnings=[],
    )
```

If `_empty_volume_profile` doesn't exist, define a local helper at the top of the function (or module) that returns a `VolumeProfile` with `price_min=0, price_max=0, price_step=1, bin_count=0, bins=[]`. Cross-reference the actual `VolumeProfile` field names against `hoga/api/models.py`.

- [ ] **Step 8.5: Run the new test, expect PASS**

Run: `uv run pytest -k "test_api_range_no_data_returns_empty_bundle" -x`
Expected: PASS.

- [ ] **Step 8.6: Run the full bundle test suite for regressions**

Run: `uv run pytest hoga/tests/api/ -x`
Expected: PASS — adapt any test that previously asserted the 404 behaviour (it should now assert empty-bundle).

- [ ] **Step 8.7: Commit**

```bash
git add hoga/api/bundle.py hoga/tests/api/
git commit -m "feat(api): /api/range returns empty bundle when no captured Stock-Date

Spec 2026-05-27 §4.3: /live's lazy fetch treats a no-data range as a
normal case (today is fetched via SSE; some past stock-dates simply
don't exist on disk). Replacing the 404 with an empty RangeBundle
lets the frontend uniformly stitch today + past without special-casing
404 handling per request."
```

---

## Task 9: Wire visible-range subscription to extend historical range

**Files:** none new — verifies Task 4's `subscribeVisibleTimeRangeChange` handler actually fires `extendHistoricalRange` end-to-end.

Phase 1 set up the handler but Task 6's manual QA didn't yet exercise lazy fetch (today-only). This task adds a focused test for the handler and a manual scroll test.

- [ ] **Step 9.1: Add a test for extendHistoricalRange logic**

Append to `frontend/src/live/LiveChartRoot.test.tsx`:

```tsx
import { useLivePageStore } from '../state/livePage';

describe('LiveChartRoot lazy fetch trigger', () => {
  it('calls extendHistoricalRange when subscribeVisibleTimeRangeChange fires with an older date', () => {
    // Capture the subscribed handler so the test can invoke it directly.
    const handlers: Array<(r: unknown) => void> = [];
    const { createChart } = require('lightweight-charts');
    createChart.mockImplementationOnce(() => ({
      addSeries: vi.fn(() => ({ setData: vi.fn(), removeSeries: vi.fn() })),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ({
        subscribeVisibleTimeRangeChange: (h: (r: unknown) => void) => {
          handlers.push(h);
        },
        unsubscribeVisibleTimeRangeChange: vi.fn(),
        applyOptions: vi.fn(),
        fitContent: vi.fn(),
        scrollToRealTime: vi.fn(),
      })),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    }));

    useLivePageStore.setState({ historicalFromDate: null });
    render(<LiveChartRoot code="005930" timeframe="1m" />, { wrapper });

    // Simulate scrolling visible range to a moment 3 days before today.
    const threeDaysAgoSec = Math.floor((Date.now() - 3 * 86400_000) / 1000);
    handlers.forEach((h) => h({ from: threeDaysAgoSec, to: threeDaysAgoSec + 600 }));

    const next = useLivePageStore.getState().historicalFromDate;
    expect(next).not.toBeNull();
    expect(typeof next).toBe('string');
    expect(next!.length).toBe(8); // YYYYMMDD
  });
});
```

- [ ] **Step 9.2: Run tests, expect PASS**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx`
Expected: PASS — Task 4's handler implementation already satisfies this.

If it FAILS, inspect: the handler must convert the seconds-resolution `range.from` to a YYYYMMDD KST string via `realMsToYyyymmdd` and call `useLivePageStore.getState().extendHistoricalRange(date)`. Fix `LiveChartRoot.tsx` accordingly until the test passes.

- [ ] **Step 9.3: Manual scroll QA**

Restart frontend (`npm run dev`) if needed. In the browser:

1. Open `/live` with an active code.
2. Drag the chart leftward until the visible range extends past today.
3. Watch the Network tab: a `GET /api/range?code=…&from=YYYYMMDD&to=YYYYMMDD&bucket_ms=…&source_pref=…` request should fire when the visible range crosses today's open going backward.
4. Past stock-dates with captured data should appear in the chart; gaps for missing dates stay empty.

If no `/api/range` request appears, debug `extendHistoricalRange` and `useLiveBundle`'s `enableRange` condition.

- [ ] **Step 9.4: Commit**

```bash
git add frontend/src/live/LiveChartRoot.test.tsx
git commit -m "test(live): cover LiveChartRoot's lazy-fetch trigger handler

Adds a direct test that simulates a scroll-to-past visible-range event
and asserts useLivePageStore.historicalFromDate gets updated. Catches
regressions in the time-to-date conversion logic or the subscribe
wiring."
```

---

## Task 10: End-to-end QA + cleanup

**Files:** none new — final regression sweep.

- [ ] **Step 10.1: Run all frontend tests**

Run: `cd frontend && npx vitest run`
Expected: all tests pass. Adapt any test that was relying on the deleted pane components.

- [ ] **Step 10.2: Run all backend tests**

Run: `uv run pytest`
Expected: all tests pass.

- [ ] **Step 10.3: Run frontend build**

Run: `cd frontend && npm run build`
Expected: TypeScript clean, Vite bundle produced.

- [ ] **Step 10.4: Manual QA scenario sweep (spec §테스트.수동 QA)**

In a browser at `http://localhost:5173/live`:

1. **Load page** → chart + sidebar both render; chart has 5 panes; status bar shows current price.
2. **Switch timeframe 1m → 5m → 30m** → all panes rebucket together; quote totals and FillStrength update without per-second jitter.
3. **Drag chart left** → all panes move together; `/api/range` request fires; data appears for past stock-dates that have captures.
4. **Switch to D timeframe** → hoga indicator panes become empty and `라이브 지표는 분봉에서 표시됩니다` notice shows; candle+volume still render.
5. **Scroll into a stock-date with no captures** → that date's slice is naturally empty (no errors).
6. **Toggle Source preference at /replay's Settings** → returning to `/live`, past data refetches with the new source; today's segment falls back to live SSE if the preferred source has no today data.
7. **Auction Window check** (when applicable — between 15:20–15:30 KST or by zooming into a past stock-date that includes the window): hoga panes hide their values per ADR-0029.

- [ ] **Step 10.5: Verify no console errors**

Open browser devtools console. No errors should fire during normal interaction. Acceptable: lightweight-charts informational messages.

- [ ] **Step 10.6: Final commit (only if anything needed touch-up)**

If Step 10.4 surfaced a bug, fix it with a targeted commit. Otherwise no commit is needed.

---

## Self-Review

**Spec coverage:**
- Section 1 (single chart + paneIndex layout) → Task 4 (`LiveChartRoot.tsx`).
- Section 2 (RangeBundle wire model + today/historical resolution + VirtualAxis) → Task 2 (`buildLiveBundle.ts`), Task 4 (creates `VirtualAxis` from segments and passes to `RangeSeriesPane`).
- Section 3 (frontend bucketing for live, backend bucketing for past) → Task 1 (`bucketHogaSeries.ts`).
- Section 4.1 (lazy fetch trigger via `subscribeVisibleTimeRangeChange`) → Task 4 wires the subscription; Task 9 covers it with a regression test.
- Section 4.2/4.3 (`/api/range` reuse with `source_pref`) → Task 3 (`useLiveBundle` calls `useRange` which threads `source_pref`).
- Section 4.3 no-data 404 handling → Task 8 (backend empty-bundle response).
- Section 4.4 merge policy → Task 2 (segment-concat in date order, past wins for today when present).
- Section 5 hoga indicator normal-behaviour definition + debug hypotheses → Task 7 verification + spec update.
- Section 6 Migration Steps → Tasks 1–5 map onto Step 1; Task 7 onto Step 2; Tasks 8–9 onto Step 3.
- Section 테스트 → Tasks 1, 2, 3, 4, 9 (unit + render tests); Task 10 (manual QA).
- Non-goals: no `/replay` change, no Drawing on `/live`, no new hoga indicator, no D/W/M hoga rendering — confirmed by Task 4 (no `DrawingOverlay`, no `VolumeProfileOverlay`) and Task 4's D/W/M empty-state notice preservation.

**Placeholder scan:** no TBD, TODO, "add appropriate handling" — every step has concrete code or commands.

**Type consistency:** `RangeBundle`, `Candle` (`ts_ms`), `QuoteRatioPoint` (`t`, `bid_total`, `ask_total`), `FillStrengthPoint` (`t`, `buy_qty`, `sell_qty`) match `frontend/src/api/types.ts:21-33,359-376`. `ObSnapshot.total_ask_qty` / `total_bid_qty` match the backend payload at [hoga/live/kis_client.py:252-253](../../hoga/live/kis_client.py#L252). `LiveCandle.t_ms` matches `frontend/src/api/liveCandles.ts:11`. Function names referenced across tasks (`buildLiveBundle`, `bucketHogaSeries`, `useLiveBundle`, `LiveChartRoot`, `extendHistoricalRange`) are consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-27-live-chart-sync-and-hoga-indicators-plan.md`.

Phase 1 (Tasks 1–6) alone solves problem 1 (timeScale sync) and problem 3 (hoga indicators correct). Phase 2 (Tasks 7–9) adds lazy fetch and confirms the debug hypothesis. Phase 3 (Task 10) is final QA.

Each task ends in a commit; tasks are mergeable individually.
