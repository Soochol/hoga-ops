import { describe, it, expect } from 'vitest';
import {
  latestOrderbookSnapshot,
  aggregateBrokerSeries,
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

  it('collapses buy + sell qty for same broker at same ts into one signed point (matches backend query_day_series)', () => {
    // Market-maker case: 키움 appears in both top-5 lists at the same snapshot.
    // Per CONTEXT.md Broker Day-Trajectory: net = SUM(qty * sign(side)) per
    // (broker, ts_ms), so one signed line — not two points where the sell
    // overwrites the buy at cursor projection.
    const broker = [
      {
        t_ms: 1000,
        buy_top: [{ name: '키움', qty: 234423 }],
        sell_top: [{ name: '키움', qty: 253901 }],
      },
    ];
    const series = aggregateBrokerSeries(broker);
    const kiwoom = series.find((s) => s.broker === '키움');
    expect(kiwoom?.points).toHaveLength(1);
    expect(kiwoom?.points[0]).toEqual({ ts_ms: 1000, net: 234423 - 253901 });
    expect(kiwoom?.final_net).toBe(234423 - 253901);
    expect(kiwoom?.dominant_side).toBe('sell');
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

