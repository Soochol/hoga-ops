import { describe, expect, it } from 'vitest';
import { createVirtualAxis } from '../util/virtualAxis';
import { buildBidPeakOverlaySegments } from './LiveBidPeakSegments';

describe('buildBidPeakOverlaySegments', () => {
  it('filters bid baseline candidates by visible-time cutoff', () => {
    const day = '20260613';
    const open = Date.UTC(2026, 5, 13, 0, 0);
    const peak = {
      date: day,
      price: 99,
      qty: 90,
      t_ms: open + 60_000,
      max_price: 99,
      max_qty: 90,
      max_t_ms: open + 60_000,
      traded_peaks: [
        { price: 99, qty: 90, t_ms: open + 60_000 },
        { price: 98, qty: 900, t_ms: open + 180_000 },
      ],
      traded_max_peaks: [
        { price: 99, qty: 90, t_ms: open + 60_000 },
        { price: 98, qty: 900, t_ms: open + 180_000 },
      ],
    };

    const segments = buildBidPeakOverlaySegments({
      dayBidPeaks: [peak],
      todayAllPriceBidPeak: null,
      segments: [{ date: day, session_open_ms: open, session_close_ms: open + 3600_000 }],
      candles: [{ ts_ms: open, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 }],
      axis: createVirtualAxis([{ date: day, sessionOpenMs: open, sessionCloseMs: open + 3600_000 }], open),
      todayKst: day,
      baselineStyle: { color: '#fff', lineWidth: 1 },
      allPriceStyle: { color: '#f00', lineWidth: 1 },
      intraMax: false,
      showAllPrices: true,
      visibleTimeCutoff: { date: day, tMs: open + 120_000 },
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ price: 99, qty: 90 });
  });
});
