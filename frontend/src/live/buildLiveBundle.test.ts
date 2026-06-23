import { describe, it, expect } from 'vitest';
import { buildHogaSeries, buildLiveBundle, createIncrementalHogaSeriesBuilder } from './buildLiveBundle';
import type { QuoteRatioPoint, RangeBundle } from '../api/types';

// buildLiveBundle dedupe/promote logic only reads t/bid_total/ask_total; the Intra-Bar Max
// fields mirror close here so the fixtures satisfy the QuoteRatioPoint shape.
const qp = (t: number, bid_total: number, ask_total: number): QuoteRatioPoint => ({
  t, bid_total, ask_total,
  bid_max: bid_total, ask_max: ask_total, imb_max_bid: bid_total, imb_max_ask: ask_total,
});

const TODAY = '20260527';
const TODAY_OPEN = Date.UTC(2026, 4, 27, 0, 0, 0);
const TODAY_CLOSE = TODAY_OPEN + 6.5 * 3600 * 1000;

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
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
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
      kisCandles: [],
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
      kisCandles: [
        { ts_ms: TODAY_OPEN, open: 70000, close: 70050, high: 70100, low: 69900, vol_a: 1000, vol_b: 0 },
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
    const past = emptyRangeBundle({
      segments: [
        { date: TODAY, session_open_ms: TODAY_OPEN, session_close_ms: TODAY_CLOSE, source: 'hogaplay' },
      ],
      candles: [
        { ts_ms: TODAY_OPEN, open: 70000, close: 70050, high: 70100, low: 69900, vol_a: 1000, vol_b: 0 },
      ],
      quote_ratio: { bucket_ms: 60_000, points: [qp(TODAY_OPEN, 500, 500)] },
      fill_strength: { bucket_ms: 60_000, points: [] },
    });
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: past,
      sseOb: [
        { t_ms: TODAY_OPEN, total_ask_qty: 999, total_bid_qty: 999 },
      ],
      sseTrade: [],
      kisCandles: [],
      bucketMs: 60_000,
    });
    expect(bundle.segments.length).toBe(1);
    expect(bundle.segments[0].source).toBe('hogaplay');
    expect(bundle.quote_ratio.points[0].ask_total).toBe(500);
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
      kisCandles: [
        { ts_ms: TODAY_OPEN, open: 70000, close: 70050, high: 70100, low: 69900, vol_a: 1000, vol_b: 0 },
      ],
      bucketMs: 60_000,
    });
    expect(bundle.segments.map((s) => s.date)).toEqual([yesterday, TODAY]);
    expect(bundle.candles.map((c) => c.ts_ms)).toEqual([TODAY_OPEN]);
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
      kisCandles: [],
      bucketMs: 60_000,
    });
    expect(bundle.segments[0].source).toBe('kis_live');
  });

  it('pastBundle.candles is ignored; kisCandles is the candle source', () => {
    const past = emptyRangeBundle({
      candles: [
        { ts_ms: TODAY_OPEN - 86400_000, open: 1, close: 2, high: 3, low: 0, vol_a: 99, vol_b: 0 },
      ],
    });
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: past,
      sseOb: [],
      sseTrade: [],
      kisCandles: [
        { ts_ms: TODAY_OPEN, open: 100, close: 100, high: 100, low: 100, vol_a: 5, vol_b: 0 },
      ],
      bucketMs: 60_000,
    });
    expect(bundle.candles).toEqual([
      { ts_ms: TODAY_OPEN, open: 100, close: 100, high: 100, low: 100, vol_a: 5, vol_b: 0 },
    ]);
  });

  it('pastBundle.ask_peaks(거래일별 매도 최대벽)를 그대로 통과시킨다 (회귀: []로 덮어쓰지 않음)', () => {
    const past = emptyRangeBundle({
      ask_peaks: [
        { date: '20260611', price: 297000, qty: 32621, t_ms: 1,
          max_price: 297000, max_qty: 32621, max_t_ms: 1 },
        { date: '20260610', price: 302500, qty: 246495, t_ms: 2,
          max_price: 302500, max_qty: 246495, max_t_ms: 2 },
      ],
    });
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: past,
      sseOb: [],
      sseTrade: [],
      kisCandles: [],
      bucketMs: 60_000,
    });
    expect(bundle.ask_peaks).toEqual(past.ask_peaks);
  });

  it('passes through pastBundle.bid_peaks and defaults to [] when absent', () => {
    const withBidPeaks = emptyRangeBundle({
      bid_peaks: [
        { date: '20260611', price: 297000, qty: 32621, t_ms: 1,
          max_price: 297000, max_qty: 32621, max_t_ms: 1 },
      ],
    });
    const withPeaks = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: withBidPeaks,
      sseOb: [],
      sseTrade: [],
      kisCandles: [],
      bucketMs: 60_000,
    });
    expect(withPeaks.bid_peaks).toEqual(withBidPeaks.bid_peaks);

    const withoutPeaks = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: emptyRangeBundle(),
      sseOb: [],
      sseTrade: [],
      kisCandles: [],
      bucketMs: 60_000,
    });
    expect(withoutPeaks.bid_peaks).toEqual([]);
  });

  it('synthesizes kis_live segments for past dates that KIS has but /api/range does not', () => {
    // /api/range only knows 5/20. KIS past-candles covers 5/8 + 5/20 + 5/26.
    // Without segment synthesis, VirtualAxis built from segments would only
    // contain 5/20, and projectCandle's axis.contains filter would drop the
    // 5/8 + 5/26 bars — that's the production bug surfaced by /investigate.
    const ONE_DAY = 86400_000;
    const date520 = '20260520';
    const ms520_open = Date.UTC(2026, 4, 20, 0, 0, 0); // 09:00 KST = 00:00 UTC
    const past = emptyRangeBundle({
      segments: [
        { date: date520, session_open_ms: ms520_open, session_close_ms: ms520_open + 6.5 * 3600_000, source: 'hogaplay' },
      ],
    });
    const ms508_open = ms520_open - 12 * ONE_DAY; // 5/8
    const ms526_open = ms520_open + 6 * ONE_DAY;  // 5/26
    const kis = [
      { ts_ms: ms508_open + 60_000, open: 1, close: 1, high: 1, low: 1, vol_a: 1, vol_b: 0 },
      { ts_ms: ms520_open + 60_000, open: 2, close: 2, high: 2, low: 2, vol_a: 1, vol_b: 0 },
      { ts_ms: ms526_open + 60_000, open: 3, close: 3, high: 3, low: 3, vol_a: 1, vol_b: 0 },
    ];
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: past,
      sseOb: [],
      sseTrade: [],
      kisCandles: kis,
      bucketMs: 60_000,
    });
    const dates = bundle.segments.map((s) => s.date);
    // 5/8 (KIS-only) + 5/20 (hogaplay) + 5/26 (KIS-only). Ascending order.
    expect(dates).toEqual(['20260508', '20260520', '20260526']);
    expect(bundle.segments[0].source).toBe('kis_live');
    expect(bundle.segments[1].source).toBe('hogaplay');
    expect(bundle.segments[2].source).toBe('kis_live');
  });
});

describe('createIncrementalHogaSeriesBuilder', () => {
  const session = { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE };
  const baseInput = {
    todaySession: session,
    pastBundle: null,
    bucketMs: 60_000,
  };
  const contLvls = (qty: number) => Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, qty }));
  const aucLvls = (qty: number) => Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, qty: i < 3 ? qty : 0 }));
  const shapedOb = (t: number, ask: number, bid: number, auction: boolean) => ({
    t_ms: t,
    total_ask_qty: ask,
    total_bid_qty: bid,
    asks: (auction ? aucLvls : contLvls)(ask),
    bids: (auction ? aucLvls : contLvls)(bid),
  });

  it('matches buildHogaSeries across append-only live ticks', () => {
    const buildIncremental = createIncrementalHogaSeriesBuilder();
    const ob = [
      { t_ms: TODAY_OPEN, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: TODAY_OPEN + 10_000, total_ask_qty: 120, total_bid_qty: 70 },
      { t_ms: TODAY_OPEN + 70_000, total_ask_qty: 90, total_bid_qty: 110 },
    ];
    const trade = [
      { t_ms: TODAY_OPEN + 5_000, trades: [{ side: 1, qty: 10 }, { side: -1, qty: 4 }] },
      { t_ms: TODAY_OPEN + 65_000, trades: [{ side: 1, qty: 7 }] },
    ];

    for (let i = 0; i <= ob.length; i++) {
      const input = {
        ...baseInput,
        sseOb: ob.slice(0, i),
        sseTrade: trade.slice(0, Math.min(i, trade.length)),
      };
      expect(buildIncremental(input)).toEqual(buildHogaSeries(input));
    }
  });

  it('falls back safely when the live buffer slides instead of only appending', () => {
    const buildIncremental = createIncrementalHogaSeriesBuilder();
    const full = [
      { t_ms: TODAY_OPEN, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: TODAY_OPEN + 60_000, total_ask_qty: 120, total_bid_qty: 90 },
      { t_ms: TODAY_OPEN + 120_000, total_ask_qty: 140, total_bid_qty: 95 },
    ];
    buildIncremental({ ...baseInput, sseOb: full.slice(0, 2), sseTrade: [] });

    const slid = full.slice(1);
    const input = { ...baseInput, sseOb: slid, sseTrade: [] };
    expect(buildIncremental(input)).toEqual(buildHogaSeries(input));
  });

  it('rebuilds safely when a later continuous book moves the auction boundary forward', () => {
    const buildIncremental = createIncrementalHogaSeriesBuilder();
    const ob = [
      shapedOb(TODAY_OPEN, 100, 80, false),
      shapedOb(TODAY_OPEN + 60_000, 900, 800, true),
      shapedOb(TODAY_OPEN + 120_000, 120, 95, false),
    ];
    const trade = [
      { t_ms: TODAY_OPEN, trades: [{ side: 1, qty: 10 }] },
      { t_ms: TODAY_OPEN + 120_000, trades: [{ side: -1, qty: 3 }] },
    ];
    buildIncremental({
      ...baseInput,
      sseOb: ob.slice(0, 2),
      sseTrade: trade.slice(0, 1),
    });

    const input = { ...baseInput, sseOb: ob, sseTrade: trade };
    expect(buildIncremental(input)).toEqual(buildHogaSeries(input));
  });

  it('does not mutate a previously returned series when later ticks update the same bucket', () => {
    const buildIncremental = createIncrementalHogaSeriesBuilder();
    const ob = [
      { t_ms: TODAY_OPEN, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: TODAY_OPEN + 10_000, total_ask_qty: 120, total_bid_qty: 90 },
    ];
    const trade = [
      { t_ms: TODAY_OPEN, trades: [{ side: 1, qty: 10 }] },
      { t_ms: TODAY_OPEN + 10_000, trades: [{ side: -1, qty: 4 }] },
    ];

    const first = buildIncremental({ ...baseInput, sseOb: ob.slice(0, 1), sseTrade: trade.slice(0, 1) });
    const firstSnapshot = structuredClone(first);

    buildIncremental({ ...baseInput, sseOb: ob, sseTrade: trade });

    expect(first).toEqual(firstSnapshot);
  });

  it('falls back safely when an appended snapshot arrives out of time order', () => {
    const buildIncremental = createIncrementalHogaSeriesBuilder();
    const ob = [
      { t_ms: TODAY_OPEN + 30_000, total_ask_qty: 130, total_bid_qty: 70 },
      { t_ms: TODAY_OPEN + 10_000, total_ask_qty: 110, total_bid_qty: 90 },
    ];
    const trade = [
      { t_ms: TODAY_OPEN + 30_000, trades: [{ side: 1, qty: 5 }] },
      { t_ms: TODAY_OPEN + 10_000, trades: [{ side: -1, qty: 3 }] },
    ];
    buildIncremental({ ...baseInput, sseOb: ob.slice(0, 1), sseTrade: trade.slice(0, 1) });

    const input = { ...baseInput, sseOb: ob, sseTrade: trade };
    expect(buildIncremental(input)).toEqual(buildHogaSeries(input));
  });
});

const MINUTE_MS = 60_000;

function makeRangeBundle(qrPoints: QuoteRatioPoint[]): RangeBundle {
  return {
    code: '003490',
    from_date: '20260527',
    to_date: '20260528',
    bucket_ms: MINUTE_MS,
    segments: [{
      date: '20260527',
      session_open_ms: 1779840000000,
      session_close_ms: 1779863400000,
      source: 'kis_live',
    }],
    candles: [],
    quote_ratio: { bucket_ms: MINUTE_MS, points: qrPoints },
    fill_strength: { bucket_ms: MINUTE_MS, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    investorPoints: [],
    ask_peaks: [],
  };
}

describe('buildLiveBundle dedup (ADR-0043 plan Task 9)', () => {
  const todayDate = '20260528';
  const todaySession = { open_ms: 1779926400000, close_ms: 1779949800000 };

  it('dedupes SSE buckets that share timestamp with parquet tail', () => {
    const pastTailT = 1779926400000;  // 5/28 09:00 KST
    const past = makeRangeBundle([
      qp(pastTailT, 1000, 2000),
    ]);

    const sseOb = [
      // 같은 t값 — parquet이 이김
      { t_ms: pastTailT + 1000, total_bid_qty: 9999, total_ask_qty: 9999 },
      // 새 timestamp — SSE가 들어감
      { t_ms: pastTailT + 60_000 + 1000, total_bid_qty: 1100, total_ask_qty: 2100 },
    ];

    const bundle = buildLiveBundle({
      code: '003490',
      todayDate,
      todaySession,
      pastBundle: past,
      sseOb,
      sseTrade: [],
      kisCandles: [],
      bucketMs: MINUTE_MS,
    });

    const ts = bundle.quote_ratio.points.map((p) => p.t);
    expect(ts).toContain(pastTailT);
    expect(ts).toContain(pastTailT + 60_000);
    expect(ts).toHaveLength(2);
    // pastTailT 위치는 parquet 값 유지
    expect(bundle.quote_ratio.points.find((p) => p.t === pastTailT)?.bid_total).toBe(1000);
  });

  it('advancing pastMaxQrT shrinks the incremental set with no gap or overlap (review C1)', () => {
    // Models the 5-min /api/range refetch advancing the today seam: the same SSE
    // tail merged against an OLD pastMaxQrT (only the first bucket is past) vs an
    // ADVANCED pastMaxQrT (past now covers the second bucket too). The advanced
    // boundary must take the bucket from `past` and drop it from incremental —
    // exactly one source per t, contiguous, no hole. Locks that the strict-`>`
    // dedup is correct at a non-zero AND a moved boundary.
    const t0 = 1779926400000; // 5/28 09:00 KST
    const t1 = t0 + 60_000;
    const sseOb = [
      { t_ms: t0 + 1000, total_bid_qty: 100, total_ask_qty: 200 },
      { t_ms: t1 + 1000, total_bid_qty: 110, total_ask_qty: 210 },
    ];
    const build = (past: RangeBundle) =>
      buildLiveBundle({
        code: '003490', todayDate, todaySession,
        pastBundle: past, sseOb, sseTrade: [], kisCandles: [], bucketMs: MINUTE_MS,
      }).quote_ratio.points;

    // Before refetch: past tail at t0, so t1 is incremental (from SSE).
    const before = build(makeRangeBundle([qp(t0, 1, 1)]));
    expect(before.map((p) => p.t)).toEqual([t0, t1]);
    expect(before.find((p) => p.t === t1)?.bid_total).toBe(110); // SSE value

    // After refetch: past tail advanced to t1 (disk promoted t1). t1 now comes
    // from past, not SSE — no duplicate, no gap.
    const after = build(
      makeRangeBundle([
        qp(t0, 1, 1),
        qp(t1, 999, 999), // promoted disk value
      ]),
    );
    expect(after.map((p) => p.t)).toEqual([t0, t1]);
    expect(after.find((p) => p.t === t1)?.bid_total).toBe(999); // past wins
  });

  it('uses all SSE buckets when past bundle is empty', () => {
    const sseOb = [
      { t_ms: 1779926401000, total_bid_qty: 100, total_ask_qty: 200 },
      { t_ms: 1779926461000, total_bid_qty: 110, total_ask_qty: 210 },
    ];

    const bundle = buildLiveBundle({
      code: '003490',
      todayDate,
      todaySession,
      pastBundle: null,
      sseOb,
      sseTrade: [],
      kisCandles: [],
      bucketMs: MINUTE_MS,
    });

    expect(bundle.quote_ratio.points.length).toBe(2);
  });

  it('appends only timestamps strictly greater than past tail', () => {
    const pastTailT = 1779926400000;
    const past = makeRangeBundle([
      qp(pastTailT, 1000, 2000),
    ]);

    const sseOb = [
      // pastTailT - 60s: 더 옛것 (버려져야 함)
      { t_ms: pastTailT - 60_000 + 1000, total_bid_qty: 50, total_ask_qty: 50 },
      // pastTailT: 동일 (parquet이 이김)
      { t_ms: pastTailT + 1000, total_bid_qty: 999, total_ask_qty: 999 },
      // pastTailT + 60s: 새것 (들어감)
      { t_ms: pastTailT + 60_000 + 1000, total_bid_qty: 1100, total_ask_qty: 2100 },
    ];

    const bundle = buildLiveBundle({
      code: '003490',
      todayDate,
      todaySession,
      pastBundle: past,
      sseOb,
      sseTrade: [],
      kisCandles: [],
      bucketMs: MINUTE_MS,
    });

    const ts = bundle.quote_ratio.points.map((p) => p.t).sort((a, b) => a - b);
    expect(ts).toEqual([pastTailT, pastTailT + 60_000]);
  });
});

describe('buildLiveBundle session-end filter (ADR-0049 / spec §3)', () => {
  const TODAY = '20260529';
  const TODAY_OPEN = Date.UTC(2026, 4, 29, 0, 0, 0);
  const TODAY_CLOSE = TODAY_OPEN + 6.5 * 3600 * 1000;
  // ADR-0044 / CONTEXT.md "Live Session": After-Hours runs 15:30–16:00 KST,
  // so the filter ceiling = close_ms + 30 min (exercised via buildLiveBundle).

  it('filters past points beyond live session end so SSE can still merge', () => {
    // Simulate the actual production failure mode: Unix ms decoded as
    // HHMMSSmmm lands deterministically in year 2046 (~20 years past today).
    // Without the filter, pastMaxQrT sits in 2046 and would block all SSE
    // merges because incrementalQR.filter(p => p.t > pastMaxQrT) rejects
    // every 2026-era SSE point.
    const futureCorruptT = TODAY_CLOSE + 20 * 365 * 24 * 3600 * 1000; // ~2046
    const pastBundle: RangeBundle = emptyRangeBundle({
      segments: [{
        date: '20260528',
        session_open_ms: TODAY_OPEN - 86_400_000,
        session_close_ms: TODAY_CLOSE - 86_400_000,
        source: 'hogaplay',
      }],
      quote_ratio: {
        bucket_ms: 60_000,
        points: [
          qp(TODAY_OPEN - 86_400_000 + 3600_000, 10, 10),
          qp(futureCorruptT, 99, 99), // corrupt tail
        ],
      },
    });

    const sseTAt = TODAY_OPEN + 30 * 60_000; // 09:30 KST today
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle,
      sseOb: [{ t_ms: sseTAt, total_ask_qty: 50, total_bid_qty: 40 }],
      sseTrade: [],
      kisCandles: [],
      bucketMs: 60_000,
    });

    const sseMerged = bundle.quote_ratio.points.some(
      (p) => p.t === sseTAt && p.bid_total === 40 && p.ask_total === 50,
    );
    expect(sseMerged).toBe(true);
  });

  it('preserves dedup for after-hours data (15:30-16:00 KST, Live Session end)', () => {
    // Design-review B1 regression: filter ceiling must include After-Hours
    // (Live Session end = close_ms + 30min, CONTEXT.md "Live Session").
    // If we filtered at close_ms (15:30 KST), a healthy past-tail at 15:45
    // KST would be dropped, letting an SSE point at the same 15:45
    // timestamp pass through and overwrite the past value.
    const pastTailT = TODAY_CLOSE + 15 * 60_000; // 15:45 KST (After-Hours)
    const pastBundle: RangeBundle = emptyRangeBundle({
      segments: [{
        date: TODAY,
        session_open_ms: TODAY_OPEN,
        session_close_ms: TODAY_CLOSE,
        source: 'kis_live',
      }],
      quote_ratio: {
        bucket_ms: 60_000,
        points: [qp(pastTailT, 10, 10)],
      },
    });

    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle,
      sseOb: [
        { t_ms: pastTailT, total_ask_qty: 999, total_bid_qty: 999 }, // boundary dup
      ],
      sseTrade: [],
      kisCandles: [],
      bucketMs: 60_000,
    });

    const atTail = bundle.quote_ratio.points.find((p) => p.t === pastTailT);
    expect(atTail?.bid_total).toBe(10); // past value wins, SSE dup rejected
  });

  it('does NOT filter when past timestamps are all within regular session (normal case)', () => {
    // Regression guard: when past data is sane, the existing dedup must
    // still reject SSE buckets that share a timestamp with past tail.
    const pastTailT = TODAY_OPEN + 60_000; // 09:01 KST today
    const pastBundle: RangeBundle = emptyRangeBundle({
      segments: [{
        date: TODAY,
        session_open_ms: TODAY_OPEN,
        session_close_ms: TODAY_CLOSE,
        source: 'kis_live',
      }],
      quote_ratio: {
        bucket_ms: 60_000,
        points: [
          qp(TODAY_OPEN, 5, 5),
          qp(pastTailT, 10, 10),
        ],
      },
    });

    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle,
      sseOb: [
        { t_ms: pastTailT, total_ask_qty: 999, total_bid_qty: 999 }, // boundary dup
        { t_ms: pastTailT + 60_000, total_ask_qty: 50, total_bid_qty: 40 }, // new
      ],
      sseTrade: [],
      kisCandles: [],
      bucketMs: 60_000,
    });

    // The boundary-dup SSE point must NOT overwrite past's value 10.
    const atPastTail = bundle.quote_ratio.points.find((p) => p.t === pastTailT);
    expect(atPastTail?.bid_total).toBe(10);
    // The strictly-greater SSE point must pass through.
    const after = bundle.quote_ratio.points.find((p) => p.t === pastTailT + 60_000);
    expect(after?.bid_total).toBe(40);
  });
});
