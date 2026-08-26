import { describe, it, expect } from 'vitest';
import { buildChartBundle, buildHogaSeries, buildLiveBundle, createIncrementalHogaSeriesBuilder } from './buildLiveBundle';
import type { QuoteRatioPoint, RangeBundle } from '../api/types';

// buildLiveBundle dedupe/promote logic only reads t/bid_total/ask_total; the Intra-Bar Max
// fields mirror close here so the fixtures satisfy the QuoteRatioPoint shape.
const qp = (t: number, bid_total: number, ask_total: number): QuoteRatioPoint => ({
  t, bid_total, ask_total,
  bid_max: bid_total, ask_max: ask_total, imb_max_bid: bid_total, imb_max_ask: ask_total,
  band_pct: 0, tick: 0,
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
    volume_distributions: overrides.volume_distributions ?? [],
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
    broker_late_entries: [],
    ...overrides,
  };
}

describe('buildLiveBundle', () => {
  it('preserves historical trade volume POC candidates on the chart bundle', () => {
    const pastBundle = {
      code: '005930',
      from_date: '20260527',
      to_date: '20260527',
      bucket_ms: 60_000,
      segments: [{
        date: '20260527',
        session_open_ms: TODAY_OPEN,
        session_close_ms: TODAY_CLOSE,
        source: 'hogaplay' as const,
      }],
      candles: [],
      quote_ratio: { bucket_ms: 60_000, points: [] },
      fill_strength: { bucket_ms: 60_000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [],
      volume_distributions: [],
      investorPoints: [],
      ask_peaks: [],
      bid_peaks: [],
      broker_late_entries: [],
      price_level_hits: [],
      trade_volume_pocs: [{
        date: '20260527',
        center_price: 72_300,
        low_price: 71_900,
        high_price: 72_700,
        qty: 1234,
        t_ms: TODAY_OPEN + 120_000,
        band_pct: 0.005,
      }],
    };

    const bundle = buildChartBundle({
      code: '005930',
      todayDate: '20260527',
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle,
      kisCandles: [{
        ts_ms: TODAY_OPEN,
        open: 72_000,
        high: 72_500,
        low: 71_800,
        close: 72_300,
        vol_a: 100,
        vol_b: 0,
      }],
      bucketMs: 60_000,
      hasTodayObSignal: false,
    });

    expect(bundle.trade_volume_pocs).toEqual(pastBundle.trade_volume_pocs);
  });

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
    expect(bundle.broker_late_entries).toEqual([]);
  });

  it('today-only: SSE + candles produce a single today segment tagged kiwoom_live', () => {
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
      { date: TODAY, session_open_ms: TODAY_OPEN, session_close_ms: TODAY_CLOSE, source: 'kiwoom_live' },
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
    // Today segment is present via the SSE orderbook signal (candle-driven policy
    // no longer reads pastBundle.segments; today survives on live signal). Its
    // source now follows the candle policy → kiwoom_live, not the hoga segment tag.
    expect(bundle.segments.length).toBe(1);
    expect(bundle.segments[0].source).toBe('kiwoom_live');
    expect(bundle.quote_ratio.points[0].ask_total).toBe(500);
  });

  it('past candle date + SSE today → segments candle-driven in date order', () => {
    const yesterday = '20260526';
    const Y_OPEN = TODAY_OPEN - 86400_000;
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      // pastBundle carries no segments — the yesterday divider must come from the
      // candle set, not hoga coverage (candle-driven policy).
      pastBundle: emptyRangeBundle({ segments: [] }),
      sseOb: [{ t_ms: TODAY_OPEN, total_ask_qty: 100, total_bid_qty: 80 }],
      sseTrade: [],
      kisCandles: [
        { ts_ms: Y_OPEN, open: 69000, close: 69500, high: 69600, low: 68900, vol_a: 800, vol_b: 0 },
        { ts_ms: TODAY_OPEN, open: 70000, close: 70050, high: 70100, low: 69900, vol_a: 1000, vol_b: 0 },
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
      kisCandles: [],
      bucketMs: 60_000,
    });
    expect(bundle.segments[0].source).toBe('kiwoom_live');
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

  it('keeps program trade points only for dates that have chart candles', () => {
    const yesterday = '20260526';
    const Y_OPEN = TODAY_OPEN - 86400_000;
    const past = emptyRangeBundle({
      from_date: yesterday,
      to_date: TODAY,
      segments: [
        { date: yesterday, session_open_ms: Y_OPEN, session_close_ms: Y_OPEN + 6.5 * 3600 * 1000, source: 'hogaplay' },
        { date: TODAY, session_open_ms: TODAY_OPEN, session_close_ms: TODAY_CLOSE, source: 'kiwoom_live' },
      ],
      program_trade: {
        points: [
          { t: Y_OPEN + 60_000, net_qty: 1, net_amount: 100_000_000, gap_risk: false },
          { t: TODAY_OPEN + 60_000, net_qty: 2, net_amount: 200_000_000, gap_risk: false },
        ],
      },
    });

    const bundle = buildChartBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle: past,
      kisCandles: [
        { ts_ms: Y_OPEN, open: 1, close: 1, high: 1, low: 1, vol_a: 1, vol_b: 0 },
      ],
      bucketMs: 60_000,
      hasTodayObSignal: false,
    });

    expect(bundle.program_trade?.points).toEqual([
      { t: Y_OPEN + 60_000, net_qty: 1, net_amount: 100_000_000, gap_risk: false },
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

  it('creates a segment for every candle date, independent of hoga coverage', () => {
    // /api/range (hoga) only knows 5/20. The candle set covers 5/8 + 5/20 + 5/26.
    // Every candle date must get a segment so VirtualAxis.contains keeps its bars
    // and each day draws its Day-Boundary divider — regardless of which dates
    // hoga captured (candle-driven policy; the /investigate 2026-05-28 bug where
    // 5/8 + 5/26 bars were dropped for lacking a segment stays fixed).
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
    // 5/8 + 5/20 + 5/26, ascending — one per candle date.
    expect(dates).toEqual(['20260508', '20260520', '20260526']);
    // Source follows the candle policy (buildLiveBundle passes no
    // candleSourceByDate here → default kiwoom_live for every candle date).
    expect(bundle.segments.map((s) => s.source)).toEqual(['kiwoom_live', 'kiwoom_live', 'kiwoom_live']);
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

  // ── 꺼진 지표 게이트 (2026-07-29 실측) ────────────────────────────────────
  // 히트맵·증감은 15분 버퍼 전체를 훑는 O(n) 인데 **기본 OFF** 이고, 종전엔 토글과
  // 무관하게 매 flush 계산됐다. 실측상 전체 재빌드 비용의 73~94% 가 이 둘이었다.
  describe('히트맵 계산 게이트', () => {
    const ob = [
      shapedOb(TODAY_OPEN, 100, 80, false),
      shapedOb(TODAY_OPEN + 10_000, 120, 70, false),
      shapedOb(TODAY_OPEN + 70_000, 90, 110, false),
    ];
    const withFlags = (heat: boolean) => ({
      ...baseInput, sseOb: ob, sseTrade: [],
      depthHeatmapEnabled: heat,
    });

    it('끄면 해당 배열이 비고, 켜면 종전과 같은 결과다', () => {
      const on = buildHogaSeries(withFlags(true));
      expect(on.depth_heatmap_today.length).toBeGreaterThan(0);

      const off = buildHogaSeries(withFlags(false));
      expect(off.depth_heatmap_today).toEqual([]);
      // 끈다고 호가비·체결강도까지 달라지면 안 된다.
      expect(off.quote_ratio).toEqual(on.quote_ratio);
      expect(off.fill_strength).toEqual(on.fill_strength);
    });

    it('증분 빌더가 플래그별로 오라클과 일치한다', () => {
      for (const heat of [true, false] as const) {
        const build = createIncrementalHogaSeriesBuilder();
        for (let i = 0; i <= ob.length; i += 1) {
          const input = {
            ...baseInput, sseOb: ob.slice(0, i), sseTrade: [],
            depthHeatmapEnabled: heat,
          };
          expect(build(input)).toEqual(buildHogaSeries(input));
        }
      }
    });

    it('장중에 토글을 켜면 누적을 재빌드해 오라클과 일치한다', () => {
      const build = createIncrementalHogaSeriesBuilder();
      // 꺼진 채로 전 구간을 흘려보낸다 — 이 동안 히트맵 버킷은 안 쌓인다.
      build(withFlags(false));
      // 켜는 순간 플래그 변화가 리셋 트리거라 전체를 다시 채워야 한다. 리셋이 없으면
      // 앞 구간이 빠진 반쪽짜리 결과가 나온다.
      expect(build(withFlags(true))).toEqual(buildHogaSeries(withFlags(true)));
    });
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

  it('ratchets depth_heatmap_today: close = last tick book, max = peak-total tick book', () => {
    const buildIncremental = createIncrementalHogaSeriesBuilder();
    // Three continuous-book ticks in ONE bucket, totals 100 → 900 → 300.
    const ob = [
      shapedOb(TODAY_OPEN, 60, 40, false), //  total 100
      shapedOb(TODAY_OPEN + 10_000, 500, 400, false), // total 900 (peak)
      shapedOb(TODAY_OPEN + 20_000, 200, 100, false), // total 300 (close)
    ];
    let out;
    for (let i = 1; i <= ob.length; i++) {
      out = buildIncremental({ ...baseInput, sseOb: ob.slice(0, i), sseTrade: [] });
    }
    expect(out!.depth_heatmap_today).toEqual([
      {
        tMs: TODAY_OPEN,
        asks: contLvls(200), // close = last tick
        bids: contLvls(100),
        asksMax: contLvls(500), // max = 900-total tick
        bidsMax: contLvls(400),
        // 가격별 최댓값 = 세 틱의 가격별 max. 이 픽스처는 레벨 qty 가 균일해서
        // 총잔량 피크 틱과 **우연히 같다** — 둘이 갈리는 판정은 아래 테스트가 한다.
        // bid 는 가격 **내림차순**이 규약이라(`DepthHeatmapPoint`) 픽스처 순서와 반대다.
        asksPriceMax: contLvls(500),
        bidsPriceMax: [...contLvls(400)].reverse(),
      },
    ]);
    // oracle parity — the one-shot builder produces the identical series.
    expect(out!.depth_heatmap_today).toEqual(
      buildHogaSeries({ ...baseInput, sseOb: ob, sseTrade: [] }).depth_heatmap_today,
    );
  });

  it('가격대별 최댓값은 총잔량 피크 틱의 사진과 다르다 — 가격마다 자기 최고 순간을 잡는다', () => {
    // 이 리포가 실제로 겪은 혼동의 최소 재현이다(005930 20260825 14:35 258,500원:
    // 자기 최고 순간 93,543 vs 총잔량 최고 순간 61,057). 두 값이 갈리려면 **어떤 가격의
    // 최고 시점이 총잔량 최고 시점과 달라야** 하므로, 레벨 qty 를 균일하게 두면
    // (contLvls) 이 테스트는 아무것도 증명하지 못한다 — 그래서 직접 만든다.
    // **10레벨이어야 한다** — `isIndicatorEligibleBook` 의 구조 술어가 얕은 북을
    // 동시호가로 보고 버킷을 통째로 드롭한다(2레벨로 쓰면 시리즈가 비어 이 테스트가
    // "undefined 읽기" 로 죽는다; 실제로 그렇게 한 번 죽였다).
    const asksOf = (best: number, rest: number) =>
      Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, qty: i === 0 ? best : rest }));
    const ob = [
      // t0: 최우선 호가(100)가 자기 최고(93). 총잔량은 183 으로 2등.
      {
        t_ms: TODAY_OPEN,
        total_ask_qty: 183, total_bid_qty: 10,
        asks: asksOf(93, 10), bids: contLvls(1),
      },
      // t1: 총잔량 최고(610) — 하지만 100 은 여기서 61 밖에 안 된다.
      {
        t_ms: TODAY_OPEN + 10_000,
        total_ask_qty: 610, total_bid_qty: 10,
        asks: asksOf(61, 61), bids: contLvls(1),
      },
    ];
    const buildIncremental = createIncrementalHogaSeriesBuilder();
    let built;
    for (let i = 1; i <= ob.length; i++) {
      built = buildIncremental({ ...baseInput, sseOb: ob.slice(0, i), sseTrade: [] });
    }
    const out = built!;
    const point = out.depth_heatmap_today[0];
    // 총잔량 피크 = t1 의 사진 통째. 최우선 호가는 61 — 93 이었던 순간을 **놓친다**.
    expect(point.asksMax).toEqual(asksOf(61, 61));
    // 가격대별 = 100 은 t0 에서(93), 나머지는 t1 에서(61) — **한 순간의 호가창이 아니다**.
    expect(point.asksPriceMax).toEqual(asksOf(93, 61));
    // 배치 오라클도 같은 답이어야 한다(배치·증분 동등성).
    expect(out.depth_heatmap_today).toEqual(
      buildHogaSeries({ ...baseInput, sseOb: ob, sseTrade: [] }).depth_heatmap_today,
    );
  });

  it('drops pre-open (opening-auction) ticks from depth_heatmap_today even with a continuous-looking book (ADR-0062 v3)', () => {
    // 공용 술어 isIndicatorEligibleBook의 개장(09:00 KST) 하한 — 개장 전 10레벨 연속북
    // (라이브 KIS WS 가정, 구조 술어 통과)이라도 depth 버킷을 만들지 않는다(드롭 = 빈 컬럼,
    // 백엔드 WHERE 사전 필터와 파리티). quote 쪽은 (0,0) 센티넬로 방출된다.
    const buildIncremental = createIncrementalHogaSeriesBuilder();
    const ob = [
      shapedOb(TODAY_OPEN - 60_000, 500, 400, false), // 08:59 KST 연속북 → 개장 하한으로 드롭
      shapedOb(TODAY_OPEN + 10_000, 60, 40, false),   // 09:00:10 KST → 유일한 depth 버킷
    ];
    const out = buildIncremental({ ...baseInput, sseOb: ob, sseTrade: [] });
    expect(out.depth_heatmap_today.map((p) => p.tMs)).toEqual([TODAY_OPEN]);
    // quote 파리티: 개장 전 버킷은 (0,0) 센티넬 슬롯으로 남는다(라인 시리즈 규약).
    expect(out.quote_ratio.points[0]).toMatchObject({ ask_total: 0, bid_total: 0 });
    // oracle parity — the one-shot builder agrees.
    expect(out.depth_heatmap_today).toEqual(
      buildHogaSeries({ ...baseInput, sseOb: ob, sseTrade: [] }).depth_heatmap_today,
    );
  });

  it('preserves depth point identity for unchanged buckets across ticks', () => {
    // 하류 depthPointToWire/depthHeatmapFromWire WeakMap 캐시의 전제 불변식:
    // "내용 변경 = 새 point 객체". 갱신 안 된 버킷은 동일 참조를 유지해야 한다.
    const buildIncremental = createIncrementalHogaSeriesBuilder();
    const bucketA = TODAY_OPEN;
    const bucketB = TODAY_OPEN + 70_000; // 다른 분봉 버킷
    const ob = [
      shapedOb(bucketA, 60, 40, false),
      shapedOb(bucketB, 100, 80, false),
      shapedOb(bucketB + 10_000, 120, 90, false), // bucketB 만 갱신
    ];
    const first = buildIncremental({ ...baseInput, sseOb: ob.slice(0, 2), sseTrade: [] });
    const aBefore = first.depth_heatmap_today[0];
    const bBefore = first.depth_heatmap_today[1];

    const second = buildIncremental({ ...baseInput, sseOb: ob, sseTrade: [] });
    expect(second.depth_heatmap_today[0]).toBe(aBefore); // 미변경 버킷 → 동일 참조
    expect(second.depth_heatmap_today[1]).not.toBe(bBefore); // 갱신된 버킷 → 새 참조
  });

  it('does NOT create a depth point for totals-only ticks (asks/bids absent)', () => {
    const buildIncremental = createIncrementalHogaSeriesBuilder();
    const ob = [
      { t_ms: TODAY_OPEN, total_ask_qty: 60, total_bid_qty: 40 },
      { t_ms: TODAY_OPEN + 10_000, total_ask_qty: 500, total_bid_qty: 400 },
    ];
    const out = buildIncremental({ ...baseInput, sseOb: ob, sseTrade: [] });
    expect(out.depth_heatmap_today).toEqual([]);
    expect(out.depth_heatmap_today).toEqual(
      buildHogaSeries({ ...baseInput, sseOb: ob, sseTrade: [] }).depth_heatmap_today,
    );
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
      source: 'kiwoom_live',
    }],
    candles: [],
    quote_ratio: { bucket_ms: MINUTE_MS, points: qrPoints },
    fill_strength: { bucket_ms: MINUTE_MS, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    broker_late_entries: [],
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
        source: 'kiwoom_live',
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
        source: 'kiwoom_live',
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

  it('preserves pastBundle.volume_distributions when no today recompute is involved', () => {
    const yesterdayOpen = TODAY_OPEN - 86400_000;
    const yesterdayClose = TODAY_CLOSE - 86400_000;
    const past = emptyRangeBundle({
      volume_distributions: [
        {
          date: '20260526',
          range_count: 10,
          price_min: 70000,
          price_max: 71000,
          session_open_ms: yesterdayOpen,
          session_close_ms: yesterdayClose,
          bins: [
            { price_low: 70000, price_high: 70100, qty: 10 },
            { price_low: 70100, price_high: 70200, qty: 20 },
          ],
        },
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

    expect(bundle.volume_distributions).toEqual(past.volume_distributions);
  });
});
