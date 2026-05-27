import { describe, it, expect } from 'vitest';
import {
  latestOrderbookSnapshot,
  aggregateBrokerSeries,
  flattenTrades,
} from './liveSidebarAdapters';

describe('latestOrderbookSnapshot', () => {
  it('returns null for empty input', () => {
    expect(latestOrderbookSnapshot([])).toBeNull();
  });

  it('returns OrderbookSnapshot shape from the latest ob entry', () => {
    const ob = [
      { t_ms: 1, asks: [], bids: [], total_ask_qty: 0, total_bid_qty: 0 },
      {
        t_ms: 2,
        asks: Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, qty: i + 1 })),
        bids: Array.from({ length: 10 }, (_, i) => ({ price: 99 - i, qty: i + 10 })),
        total_ask_qty: 55,
        total_bid_qty: 100,
      },
    ];
    const snap = latestOrderbookSnapshot(ob);
    expect(snap).not.toBeNull();
    expect(snap!.ts_ms).toBe(2);
    expect(snap!.ask).toHaveLength(10);
    expect(snap!.ask[0]).toEqual({ price: 100, qty: 1 });
    expect(snap!.bid[0]).toEqual({ price: 99, qty: 10 });
    expect(snap!.tot_ask).toBe(55);
    expect(snap!.tot_bid).toBe(100);
  });

  it('pads short ask/bid arrays to length 10 with zeros', () => {
    const snap = latestOrderbookSnapshot([
      { t_ms: 1, asks: [{ price: 100, qty: 5 }], bids: [], total_ask_qty: 5, total_bid_qty: 0 },
    ]);
    expect(snap!.ask).toHaveLength(10);
    expect(snap!.bid).toHaveLength(10);
    expect(snap!.bid[0]).toEqual({ price: 0, qty: 0 });
  });
});

describe('aggregateBrokerSeries', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateBrokerSeries([])).toEqual([]);
  });

  it('builds per-broker time series with signed net (buy = +, sell = -)', () => {
    const broker = [
      {
        t_ms: 1000,
        buy_top: [{ name: '미래에셋', qty: 100 }],
        sell_top: [{ name: '신한', qty: 50 }],
      },
      {
        t_ms: 2000,
        buy_top: [{ name: '미래에셋', qty: 200 }],
        sell_top: [{ name: '신한', qty: 80 }],
      },
    ];
    const series = aggregateBrokerSeries(broker);
    const mirae = series.find((s) => s.broker === '미래에셋');
    const shinhan = series.find((s) => s.broker === '신한');
    expect(mirae?.points).toHaveLength(2);
    expect(mirae?.points[1].net).toBe(200);
    expect(mirae?.dominant_side).toBe('buy');
    expect(shinhan?.points[1].net).toBe(-80);
    expect(shinhan?.dominant_side).toBe('sell');
  });

  it('sorts by abs(final_net) desc and caps at 10', () => {
    const broker = [
      {
        t_ms: 1000,
        buy_top: Array.from({ length: 5 }, (_, i) => ({ name: `B${i}`, qty: (i + 1) * 100 })),
        sell_top: Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, qty: (i + 1) * 50 })),
      },
    ];
    const series = aggregateBrokerSeries(broker);
    expect(series).toHaveLength(10);
    // First entry has largest abs(final_net)
    expect(Math.abs(series[0].final_net)).toBeGreaterThanOrEqual(Math.abs(series[1].final_net));
  });
});

describe('flattenTrades', () => {
  it('returns empty array for empty input', () => {
    expect(flattenTrades([])).toEqual([]);
  });

  it('flattens nested trades arrays into a single sorted-by-ts list', () => {
    const trade = [
      { t_ms: 1000, trades: [{ t_ms: 1000, price: 100, qty: 5, side: 1 }] },
      {
        t_ms: 2000,
        trades: [
          { t_ms: 2000, price: 101, qty: 3, side: -1 },
          { t_ms: 2001, price: 101, qty: 2, side: 1 },
        ],
      },
    ];
    const flat = flattenTrades(trade);
    expect(flat).toHaveLength(3);
    expect(flat[0].ts_ms).toBe(1000);
    expect(flat[2].ts_ms).toBe(2001);
  });

  it('fills in placeholder Trade fields the sidebar needs', () => {
    const flat = flattenTrades([
      { t_ms: 1000, trades: [{ t_ms: 1000, price: 100, qty: 5, side: 1 }] },
    ]);
    expect(flat[0].price).toBe(100);
    expect(flat[0].qty).toBe(5);
    expect(flat[0].side).toBe(1);
    // Live data doesn't have change_pct etc. — adapters fill with zero defaults.
    expect(typeof flat[0].change_pct).toBe('number');
  });
});
