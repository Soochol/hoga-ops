import { describe, it, expect } from 'vitest';
import { buildLiveBundle } from './buildLiveBundle';
import type { RangeBundle } from '../api/types';

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
        { t_ms: TODAY_OPEN, total_ask_qty: 999, total_bid_qty: 999 },
      ],
      sseTrade: [],
      todayCandles: [],
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
