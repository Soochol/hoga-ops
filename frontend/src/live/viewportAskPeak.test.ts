import { describe, expect, it } from 'vitest';
import type { RangeSegment } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import {
  buildLiveAskPeakPoints,
  buildViewportAskPeakSeries,
  computeViewportAskPeak,
  mergeAskPeakSeries,
} from './viewportAskPeak';

const axis = {
  toReal: (virtualMs: number) => virtualMs,
} as VirtualAxis;

const segment = (date: string, open: number, close: number): RangeSegment => ({
  date,
  session_open_ms: open,
  session_close_ms: close,
  source: 'hogaplay',
});

describe('computeViewportAskPeak', () => {
  it('returns the last point at or left of the visible right edge within that day', () => {
    const points = [
      { t: 1000, price: 25000, qty: 100 },
      { t: 2000, price: 25100, qty: 5000 },
      { t: 3000, price: 25200, qty: 200 },
    ];

    expect(computeViewportAskPeak(points, { from: 0, to: 2.1 }, axis, [
      segment('20260613', 0, 10_000),
    ])).toEqual({
      t_ms: 2000,
      price: 25100,
      qty: 5000,
    });
  });

  it('does not leak the prior day peak into the visible right-edge day', () => {
    const points = [
      { t: 1000, price: 25000, qty: 9000 },
      { t: 10_000, price: 25100, qty: 100 },
    ];

    expect(computeViewportAskPeak(points, { from: 0, to: 10.5 }, axis, [
      segment('20260612', 0, 5000),
      segment('20260613', 10_000, 20_000),
    ])).toEqual({
      t_ms: 10_000,
      price: 25100,
      qty: 100,
    });
  });
});

describe('buildLiveAskPeakPoints', () => {
  it('builds a bucket-aligned running max from live orderbook snapshots', () => {
    const points = buildLiveAskPeakPoints([
      {
        t_ms: 90_000_000,
        total_ask_qty: 0,
        total_bid_qty: 0,
        asks: [{ price: 25000, qty: 10 }, { price: 25100, qty: 20 }, { price: 25200, qty: 30 }, { price: 25300, qty: 40 }],
        bids: [{ price: 24900, qty: 1 }, { price: 24800, qty: 1 }, { price: 24700, qty: 1 }, { price: 24600, qty: 1 }],
      },
      {
        t_ms: 90_060_000,
        total_ask_qty: 0,
        total_bid_qty: 0,
        asks: [{ price: 25000, qty: 5000 }, { price: 25100, qty: 20 }, { price: 25200, qty: 30 }, { price: 25300, qty: 40 }],
        bids: [{ price: 24900, qty: 1 }, { price: 24800, qty: 1 }, { price: 24700, qty: 1 }, { price: 24600, qty: 1 }],
      },
    ], 60_000);

    expect(points).toEqual([
      { t: 90_000_000, price: 25300, qty: 40 },
      { t: 90_060_000, price: 25000, qty: 5000 },
    ]);
  });

  it('continues from the prefix seed instead of dropping below it', () => {
    const points = buildLiveAskPeakPoints([
      {
        t_ms: 90_060_000,
        total_ask_qty: 0,
        total_bid_qty: 0,
        asks: [{ price: 25000, qty: 10 }, { price: 25100, qty: 20 }, { price: 25200, qty: 30 }, { price: 25300, qty: 40 }],
        bids: [{ price: 24900, qty: 1 }, { price: 24800, qty: 1 }, { price: 24700, qty: 1 }, { price: 24600, qty: 1 }],
      },
    ], 60_000, { t: 90_000_000, price: 25500, qty: 5000 });

    expect(points).toEqual([
      { t: 90_060_000, price: 25500, qty: 5000 },
    ]);
  });

  it('ignores pre-open and collapsed single-price live books', () => {
    const points = buildLiveAskPeakPoints([
      {
        t_ms: -60_000,
        total_ask_qty: 0,
        total_bid_qty: 0,
        asks: [{ price: 25000, qty: 9999 }, { price: 25100, qty: 1 }, { price: 25200, qty: 1 }, { price: 25300, qty: 1 }],
        bids: [{ price: 24900, qty: 1 }, { price: 24800, qty: 1 }, { price: 24700, qty: 1 }, { price: 24600, qty: 1 }],
      },
      {
        t_ms: 90_060_000,
        total_ask_qty: 0,
        total_bid_qty: 0,
        asks: [{ price: 25000, qty: 9999 }, { price: 25100, qty: 1 }, { price: 25200, qty: 1 }],
        bids: [{ price: 24900, qty: 1 }, { price: 24800, qty: 1 }, { price: 24700, qty: 1 }],
      },
      {
        t_ms: 90_120_000,
        total_ask_qty: 0,
        total_bid_qty: 0,
        asks: [{ price: 25000, qty: 10 }, { price: 25100, qty: 20 }, { price: 25200, qty: 30 }, { price: 25300, qty: 40 }],
        bids: [{ price: 24900, qty: 1 }, { price: 24800, qty: 1 }, { price: 24700, qty: 1 }, { price: 24600, qty: 1 }],
      },
    ], 60_000);

    expect(points).toEqual([
      { t: 90_120_000, price: 25300, qty: 40 },
    ]);
  });
});

describe('mergeAskPeakSeries', () => {
  it('keeps the larger same-bucket point when merging prefix and live points', () => {
    expect(mergeAskPeakSeries(
      [{ t: 1, price: 100, qty: 10 }, { t: 2, price: 200, qty: 20 }],
      [{ t: 2, price: 250, qty: 5 }, { t: 3, price: 300, qty: 30 }],
    )).toEqual([
      { t: 1, price: 100, qty: 10 },
      { t: 2, price: 200, qty: 20 },
      { t: 3, price: 300, qty: 30 },
    ]);
  });

  it('keeps the merged projection monotonic when prefix and live ranges overlap', () => {
    expect(mergeAskPeakSeries(
      [{ t: 1, price: 100, qty: 10 }, { t: 3, price: 300, qty: 50 }],
      [{ t: 2, price: 200, qty: 20 }, { t: 4, price: 400, qty: 25 }],
    )).toEqual([
      { t: 1, price: 100, qty: 10 },
      { t: 2, price: 200, qty: 20 },
      { t: 3, price: 300, qty: 50 },
      { t: 4, price: 300, qty: 50 },
    ]);
  });

  it('resets the running best at KST trading-day boundaries', () => {
    expect(mergeAskPeakSeries(
      [
        { t: 1_000, price: 100, qty: 9000 },
        { t: 90_000_000, price: 200, qty: 100 },
      ],
      [{ t: 90_060_000, price: 210, qty: 200 }],
    )).toEqual([
      { t: 1_000, price: 100, qty: 9000 },
      { t: 90_000_000, price: 200, qty: 100 },
      { t: 90_060_000, price: 210, qty: 200 },
    ]);
  });
});

describe('buildViewportAskPeakSeries', () => {
  it('selects the prefix seed and merges live points behind one interface', () => {
    const points = buildViewportAskPeakSeries({
      prefixPoints: [
        { t: 90_000_000, price: 25500, qty: 5000 },
        { t: 91_000_000, price: 25600, qty: 6000 },
      ],
      liveOrderbooks: [
        {
          t_ms: 90_060_000,
          total_ask_qty: 0,
          total_bid_qty: 0,
          asks: [{ price: 25000, qty: 10 }, { price: 25100, qty: 20 }, { price: 25200, qty: 30 }, { price: 25300, qty: 40 }],
          bids: [{ price: 24900, qty: 1 }, { price: 24800, qty: 1 }, { price: 24700, qty: 1 }, { price: 24600, qty: 1 }],
        },
      ],
      bucketMs: 60_000,
      todayKst: '19700102',
    });

    expect(points).toEqual([
      { t: 90_000_000, price: 25500, qty: 5000 },
      { t: 90_060_000, price: 25500, qty: 5000 },
      { t: 91_000_000, price: 25600, qty: 6000 },
    ]);
  });

  it('uses the earliest live snapshot for seed selection even when live orderbooks are unsorted', () => {
    const points = buildViewportAskPeakSeries({
      prefixPoints: [
        { t: 90_000_000, price: 25500, qty: 5000 },
        { t: 90_100_000, price: 25600, qty: 9000 },
      ],
      liveOrderbooks: [
        {
          t_ms: 90_120_000,
          total_ask_qty: 0,
          total_bid_qty: 0,
          asks: [{ price: 25000, qty: 10 }, { price: 25100, qty: 20 }, { price: 25200, qty: 30 }, { price: 25300, qty: 40 }],
          bids: [{ price: 24900, qty: 1 }, { price: 24800, qty: 1 }, { price: 24700, qty: 1 }, { price: 24600, qty: 1 }],
        },
        {
          t_ms: 90_060_000,
          total_ask_qty: 0,
          total_bid_qty: 0,
          asks: [{ price: 25000, qty: 10 }, { price: 25100, qty: 20 }, { price: 25200, qty: 30 }, { price: 25300, qty: 40 }],
          bids: [{ price: 24900, qty: 1 }, { price: 24800, qty: 1 }, { price: 24700, qty: 1 }, { price: 24600, qty: 1 }],
        },
      ],
      bucketMs: 60_000,
      todayKst: '19700102',
    });

    expect(points).toEqual([
      { t: 90_000_000, price: 25500, qty: 5000 },
      { t: 90_060_000, price: 25500, qty: 5000 },
      { t: 90_100_000, price: 25600, qty: 9000 },
      { t: 90_120_000, price: 25600, qty: 9000 },
    ]);
  });
});
