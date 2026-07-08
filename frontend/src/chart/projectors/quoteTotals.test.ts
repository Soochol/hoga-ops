import { describe, it, expect } from 'vitest';
import { projectBid, projectAsk, QUOTE_TOTALS_SPEC, askSurgeMarkers } from './quoteTotals';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);
const bid = '#F04452';
const ask = '#3485FA';

describe('projectBid', () => {
  it('maps quote_ratio.points to {time, bid_total} in virtual seconds', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs + 1000, bid_total: 150, ask_total: 180 },
        ],
      },
    };
    expect(projectBid(bundle, axis, false)).toEqual([
      { time: 0, value: 100, color: bid },
      { time: 1, value: 150, color: bid },
    ]);
  });

  it('drops pre-open auction points via axis.contains', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs - 30 * 60_000, bid_total: 99, ask_total: 99 },
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
        ],
      },
    };
    expect(projectBid(bundle, axis, false)).toHaveLength(1);
    expect((projectBid(bundle, axis, false) as { time: number; value: number }[])[0].value).toBe(100);
  });
});

describe('projectAsk', () => {
  it('maps quote_ratio.points to {time, ask_total} in virtual seconds', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs + 1000, bid_total: 150, ask_total: 180 },
        ],
      },
    };
    expect(projectAsk(bundle, axis, false)).toEqual([
      { time: 0, value: 200, color: ask },
      { time: 1, value: 180, color: ask },
    ]);
  });

  it('keeps both quote-total sides bright regardless of ratio dominance', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 300, ask_total: 100 },
          { t: sessionOpenMs + 1000, bid_total: 100, ask_total: 300 },
          { t: sessionOpenMs + 2000, bid_total: 100, ask_total: 100 },
        ],
      },
    };
    expect(projectBid(bundle, axis, false).map((p) => p.color)).toEqual([bid, bid, bid]);
    expect(projectAsk(bundle, axis, false).map((p) => p.color)).toEqual([ask, ask, ask]);
  });
});

describe('closing-auction-window hide', () => {
  it('emits in-window bid/ask points with transparent per-point color when auctionWindowMask=true', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000; // 15:20 KST
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },              // outside → kept
          { t: auctionStartMs + 60_000, bid_total: 500, ask_total: 900 },    // inside → transparent
          { t: auctionStartMs + 120_000, bid_total: 600, ask_total: 1000 },  // inside → transparent
        ],
      },
    };
    const bids = projectBid(bundle, axis, true);
    const asks = projectAsk(bundle, axis, true);

    // Each series: 1 kept data point + 2 in-auction transparent points = 3 entries.
    // The transparent per-point color makes the outgoing line segment invisible
    // (ADR-0029), keeping the bar-index density for AuctionWindowOverlay's
    // timeToCoordinate while breaking the visible line.
    expect(bids).toHaveLength(3);
    expect(asks).toHaveLength(3);

    // The last pre-auction point's OUTGOING connector is transparent so the line
    // does not slope from the last continuous bucket into the auction window
    // (ADR-0029 connector-gap fix). Its value is still shown via the incoming
    // segment from the prior visible point.
    expect(bids[0]).toEqual({ time: 0, value: 100, color: 'rgba(0,0,0,0)' });
    expect(asks[0]).toEqual({ time: 0, value: 200, color: 'rgba(0,0,0,0)' });

    const t1 = (auctionStartMs + 60_000 - sessionOpenMs) / 1000;
    const t2 = (auctionStartMs + 120_000 - sessionOpenMs) / 1000;
    expect(bids[1]).toEqual({ time: t1, value: 0, color: 'rgba(0,0,0,0)' });
    expect(asks[1]).toEqual({ time: t1, value: 0, color: 'rgba(0,0,0,0)' });
    expect(bids[2]).toEqual({ time: t2, value: 0, color: 'rgba(0,0,0,0)' });
    expect(asks[2]).toEqual({ time: t2, value: 0, color: 'rgba(0,0,0,0)' });
  });

  it('breaks the connector from the last pre-auction point into the masked run', () => {
    // ADR-0029 gap: the mask transparents each masked point's OUTGOING segment,
    // but the connector FROM the last visible (pre-auction) point INTO the first
    // masked point stayed visible — the 총잔량 line sloped from the last
    // continuous bucket (e.g. 274/404) down into the auction window toward the
    // masked value=0. The last pre-auction point's outgoing segment must be
    // transparent too. (numbers from 한진칼 2026-06-04 3m 15:18 bucket.)
    const auctionStartMs = sessionOpenMs + 22_800_000; // 15:20 KST
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: auctionStartMs - 60_000, bid_total: 274, ask_total: 404 }, // last continuous (15:19)
          { t: auctionStartMs + 60_000, bid_total: 33, ask_total: 3039 },  // auction (masked)
        ],
      },
    };
    const tCont = (auctionStartMs - 60_000 - sessionOpenMs) / 1000;
    const tAuc = (auctionStartMs + 60_000 - sessionOpenMs) / 1000;
    expect(projectBid(bundle, axis, true)).toEqual([
      { time: tCont, value: 274, color: 'rgba(0,0,0,0)' },
      { time: tAuc, value: 0, color: 'rgba(0,0,0,0)' },
    ]);
    expect(projectAsk(bundle, axis, true)).toEqual([
      { time: tCont, value: 404, color: 'rgba(0,0,0,0)' },
      { time: tAuc, value: 0, color: 'rgba(0,0,0,0)' },
    ]);
  });

  it('keeps in-window points when auctionWindowMask=false', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000;
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: auctionStartMs + 60_000, bid_total: 500, ask_total: 900 },
        ],
      },
    };
    expect(projectBid(bundle, axis, false)).toEqual([
      { time: (auctionStartMs + 60_000 - sessionOpenMs) / 1000, value: 500, color: bid },
    ]);
    expect(projectAsk(bundle, axis, false)).toEqual([
      { time: (auctionStartMs + 60_000 - sessionOpenMs) / 1000, value: 900, color: ask },
    ]);
  });
});

describe('QUOTE_TOTALS_SPEC crosshair marker', () => {
  // The Auction Mask connector-break transparents the last pre-auction point's
  // per-point `color`; for a LineSeries that also drives the crosshair marker,
  // so the marker would vanish at that point (the 15:19 dot on 1m). A solid
  // series-level crosshairMarkerBackgroundColor decouples the marker from the
  // per-point color and keeps the dot — matching 호가비 (BaselineSeries). Lock
  // it so a future options refactor can't silently drop the marker.
  // options are thunks (resolved at addSeries time so colors follow the theme).
  const resolveOpts = (s: (typeof QUOTE_TOTALS_SPEC.series)[number]) =>
    (typeof s.options === 'function' ? s.options() : s.options) as {
      crosshairMarkerBackgroundColor?: string;
      lineWidth?: number;
    };

  it('pins each line a solid crosshairMarkerBackgroundColor (not transparent)', () => {
    const colors = QUOTE_TOTALS_SPEC.series.map((s) => resolveOpts(s).crosshairMarkerBackgroundColor);
    expect(colors).toHaveLength(2);
    for (const c of colors) {
      expect(c).toBeTruthy();
      expect(c).not.toBe('rgba(0,0,0,0)');
    }
  });

  it('uses a thicker stroke to match the clearer ratio pane treatment', () => {
    expect(QUOTE_TOTALS_SPEC.series.map((s) => resolveOpts(s).lineWidth)).toEqual([3, 3]);
  });
});

describe('급증 마커 (askSurgeMarkers) — 근접 95% + 재무장 85%', () => {
  const ctx = { auctionMask: false, intraMax: false, surgeEnabled: true, surgeApproachPct: 95, surgeRearmPct: 85, surgeStartHHMM: 900 };
  const bundle: any = {
    quote_ratio: {
      points: [
        { t: sessionOpenMs, bid_total: 0, ask_total: 100 },           // 고가 100
        { t: sessionOpenMs + 1000, bid_total: 0, ask_total: 80 },      // 80 < 85% → 재무장
        { t: sessionOpenMs + 2000, bid_total: 0, ask_total: 96 },      // 96 ≥ 95% → 발사
      ],
    },
    segments: [{ session_open_ms: sessionOpenMs, session_close_ms: sessionOpenMs + 23_400_000 }],
  };

  it('직전 고가 96% 재접근 지점에 마커(time·price·color) — 라벨 없는 점, SurgeMarkersPrimitive가 렌더', () => {
    const m = askSurgeMarkers(bundle, axis, ctx);
    expect(m).toHaveLength(1);
    expect(m[0].time).toBe(2); // toVirtual(+2000ms)/1000 = 2초 (라인과 동일 좌표계)
    expect(m[0].price).toBe(96); // 그 시점 ask_total(총잔량 값) → priceToCoordinate 입력
    expect(m[0].color).toBeTruthy();
  });

  it('surgeEnabled=false면 마커 없음', () => {
    expect(askSurgeMarkers(bundle, axis, { ...ctx, surgeEnabled: false })).toEqual([]);
  });

  it('surgeStartHHMM 시작 시각 이전 급증은 표시에서 가린다 (알고리즘은 그대로 진행)', () => {
    // sessionOpenMs = 09:00 KST → 발사 시점 09:00:02 = 자정 기준 540분.
    // 시작 시각 09:30(=930, 570분)으로 올리면 540 < 570 이라 표시 제외.
    expect(askSurgeMarkers(bundle, axis, { ...ctx, surgeStartHHMM: 930 })).toEqual([]);
    // 09:00(=900, 540분)이면 540 >= 540 경계 포함 — 그대로 표시.
    expect(askSurgeMarkers(bundle, axis, { ...ctx, surgeStartHHMM: 900 })).toHaveLength(1);
  });
});

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
      { time: 120, value: 150, color: bid },
    ]);
    expect(projectAsk(bundle, axis, false)).toEqual([
      { time: 0, value: 200, color: 'rgba(0,0,0,0)' },
      { time: 60, value: 0, color: 'rgba(0,0,0,0)' },
      { time: 120, value: 250, color: ask },
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
      { time: 120, value: 150, color: bid },
    ]);
    expect(QUOTE_TOTALS_SPEC.series[1].data(bundle, axis, ctx)).toEqual([
      { time: 0, value: 200, color: 'rgba(0,0,0,0)' },
      { time: 60, value: 0, color: 'rgba(0,0,0,0)' },
      { time: 120, value: 250, color: ask },
    ]);
  });
});
