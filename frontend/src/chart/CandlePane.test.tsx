import { render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Capture series.setData calls to inspect per-candle colors.
const setData = vi.fn();
const removeSeries = vi.fn();
const addSeries = vi.fn(() => ({ setData }));

vi.mock('lightweight-charts', async () => {
  const actual = await vi.importActual<typeof import('lightweight-charts')>('lightweight-charts');
  return { ...actual, CandlestickSeries: 'CandlestickSeries' };
});

import CandlePane from './CandlePane';
import { buildSegments } from '../util/time';

const makeChart = () =>
  ({
    addSeries,
    removeSeries,
    panes: () => [{ setStretchFactor: vi.fn() }],
  }) as any;

function makeBundle(
  segments: { date: string; sessionOpenMs: number; sessionCloseMs: number }[],
  candles: { ts_ms: number; open: number; close: number; high: number; low: number }[],
): any {
  // Test bundle uses the loose `as any` shape — CandlePane's behavior depends only
  // on `bundle.candles` and the `segments` prop, not on the full SessionBundle/RangeBundle
  // wire shape. Task 17 will migrate the prop type from SessionBundle → RangeBundle.
  return {
    code: '005930',
    date: segments[0].date,
    // SessionBundle compat (legacy; ignored by new per-segment threshold)
    session_open_ms: segments[0].sessionOpenMs,
    session_close_ms: segments[0].sessionCloseMs,
    // RangeBundle compat (forward-looking)
    from_date: segments[0].date,
    to_date: segments[segments.length - 1].date,
    bucket_ms: 60_000,
    segments: segments.map((s) => ({
      date: s.date,
      session_open_ms: s.sessionOpenMs,
      session_close_ms: s.sessionCloseMs,
    })),
    candles: candles.map((c) => ({ ...c, vol_a: 0, vol_b: 0 })),
    quote_ratio: { bucket_ms: 60_000, points: [] },
    depth_intensity: { bucket_ms: 60_000, price_min: 0, price_max: 0, bin_count: 0, bin_width: 0, points: [] },
    depth_intensity_by_day: [],
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
  };
}

const AUCTION_OFFSET_MS = (6 * 3600 + 20 * 60) * 1000;

describe('CandlePane — per-segment Auction Window threshold (multi-day)', () => {
  beforeEach(() => {
    setData.mockClear();
    addSeries.mockClear();
  });

  it('multi-day: candles before each segment auction threshold are NOT muted; after are muted', () => {
    const day1Open = 1_715_500_000_000; // arbitrary day-1 09:00
    const day1Auction = day1Open + AUCTION_OFFSET_MS;
    const day2Open = day1Open + 24 * 3600_000;
    const day2Auction = day2Open + AUCTION_OFFSET_MS;
    const segs = [
      { date: '20260512', sessionOpenMs: day1Open, sessionCloseMs: day1Open + 6.5 * 3600_000 },
      { date: '20260513', sessionOpenMs: day2Open, sessionCloseMs: day2Open + 6.5 * 3600_000 },
    ];
    const built = buildSegments(segs);
    const candles = [
      { ts_ms: day1Open + 1000, open: 100, close: 101, high: 102, low: 99 }, // day1 normal
      { ts_ms: day1Auction + 1000, open: 100, close: 101, high: 102, low: 99 }, // day1 muted
      { ts_ms: day2Open + 1000, open: 200, close: 201, high: 202, low: 199 }, // day2 normal (NOT muted by day1)
      { ts_ms: day2Auction + 1000, open: 200, close: 201, high: 202, low: 199 }, // day2 muted
    ];
    const bundle = makeBundle(segs, candles);

    render(
      <CandlePane chart={makeChart()} bundle={bundle} segments={built} paneIndex={0} />,
    );

    expect(setData).toHaveBeenCalledTimes(1);
    const data = setData.mock.calls[0][0] as { color: string }[];
    expect(data).toHaveLength(4);
    // (0,2) are pre-auction colored; (1,3) are post-auction muted.
    expect(data[0].color).not.toBe(data[1].color);
    expect(data[2].color).not.toBe(data[3].color);
    expect(data[1].color).toBe(data[3].color); // both muted
    expect(data[0].color).not.toBe(data[3].color);
  });

  it('regression: N=1 (single-day degenerate) renders identically', () => {
    const day1Open = 1_715_500_000_000;
    const day1Auction = day1Open + AUCTION_OFFSET_MS;
    const segs = [
      { date: '20260512', sessionOpenMs: day1Open, sessionCloseMs: day1Open + 6.5 * 3600_000 },
    ];
    const built = buildSegments(segs);
    const candles = [
      { ts_ms: day1Open + 1000, open: 100, close: 101, high: 102, low: 99 },
      { ts_ms: day1Auction + 1000, open: 100, close: 101, high: 102, low: 99 },
    ];
    const bundle = makeBundle(segs, candles);

    render(
      <CandlePane chart={makeChart()} bundle={bundle} segments={built} paneIndex={0} />,
    );

    expect(setData).toHaveBeenCalledTimes(1);
    const data = setData.mock.calls[0][0] as { color: string }[];
    expect(data).toHaveLength(2);
    expect(data[0].color).not.toBe(data[1].color); // pre-auction colored, post-auction muted
  });
});
