import { describe, it, expect } from 'vitest';
import { bucketHogaSeries } from './bucketHogaSeries';

describe('bucketHogaSeries', () => {
  it('returns empty arrays for empty input', () => {
    const out = bucketHogaSeries([], [], 60_000);
    expect(out.quoteRatioPoints).toEqual([]);
    expect(out.fillStrengthPoints).toEqual([]);
  });

  it('Quote Totals uses last ob snapshot in each bucket', () => {
    const ob = [
      { t_ms: 1700_000_000_000, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: 1700_000_010_000, total_ask_qty: 200, total_bid_qty: 90 },
      { t_ms: 1700_000_070_000, total_ask_qty: 300, total_bid_qty: 95 },
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    const b1 = Math.floor(1700_000_070_000 / 60_000) * 60_000;
    expect(quoteRatioPoints).toEqual([
      { t: b0, ask_total: 200, bid_total: 90 },
      { t: b1, ask_total: 300, bid_total: 95 },
    ]);
  });

  it('FillStrength sums buy/sell qty by side in each bucket', () => {
    const trade = [
      {
        t_ms: 1700_000_000_000,
        trades: [
          { side: 1, qty: 10 },
          { side: -1, qty: 4 },
          { side: 0, qty: 99 },
          { side: 2, qty: 50 },
        ],
      },
      {
        t_ms: 1700_000_010_000,
        trades: [{ side: 1, qty: 5 }],
      },
      {
        t_ms: 1700_000_070_000,
        trades: [{ side: -1, qty: 7 }],
      },
    ];
    const { fillStrengthPoints } = bucketHogaSeries([], trade, 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    const b1 = Math.floor(1700_000_070_000 / 60_000) * 60_000;
    expect(fillStrengthPoints).toEqual([
      { t: b0, buy_qty: 15, sell_qty: 4 },
      { t: b1, buy_qty: 0, sell_qty: 7 },
    ]);
  });

  it('omits empty buckets (no zero-padding)', () => {
    const ob = [
      { t_ms: 1700_000_000_000, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: 1700_000_300_000, total_ask_qty: 200, total_bid_qty: 90 },
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    expect(quoteRatioPoints.length).toBe(2);
    expect(quoteRatioPoints[1].t - quoteRatioPoints[0].t).toBe(300_000);
  });

  it('out-of-order input is sorted before bucketing', () => {
    const ob = [
      { t_ms: 1700_000_070_000, total_ask_qty: 300, total_bid_qty: 95 },
      { t_ms: 1700_000_000_000, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: 1700_000_010_000, total_ask_qty: 200, total_bid_qty: 90 },
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    const b1 = Math.floor(1700_000_070_000 / 60_000) * 60_000;
    expect(quoteRatioPoints).toEqual([
      { t: b0, ask_total: 200, bid_total: 90 },
      { t: b1, ask_total: 300, bid_total: 95 },
    ]);
  });
});
