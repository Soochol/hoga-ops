import { describe, expect, it } from 'vitest';
import { secondPriceDistribution, movingAverageSeconds } from './secondAggregateProjectors';
import type { SecondBar, SecondPrice } from '../../api/secondAggregates';

describe('shared second data consumers', () => {
  it('profiles observed regular-session executions without unknown-side volume', () => {
    const t = new Date('2026-09-30T09:00:00+09:00').getTime();
    const prices: SecondPrice[] = [
      { t_ms: t, price: 100, side: 1, qty: 2, count: 1 },
      { t_ms: t+1000, price: 110, side: -1, qty: 3, count: 1 },
      { t_ms: t+2000, price: 105, side: 0, qty: 99, count: 1 },
      { t_ms: t-1000, price: 90, side: 1, qty: 50, count: 1 },
    ];
    const profile = secondPriceDistribution(prices, '20260930', 10)!;
    expect(profile.bins.reduce((sum, b) => sum + b.qty, 0)).toBe(5);
    expect(profile.price_min).toBe(100);
    expect(profile.price_max).toBe(110);
    expect(profile.last_trade_ms).toBe(t+1000);
    expect(secondPriceDistribution([], '20260930', 10)).toBeNull();
  });
  it('computes MA over observed bars and never fabricates missing bars', () => {
    const bars: SecondBar[] = [1000, 11000, 31000].map((t_ms, i) => ({ t_ms,
      open: i+1, close: i+1, high: i+1, low: i+1, volume: 1, count: 1, trade_value: i+1 }));
    expect(movingAverageSeconds(bars, 2)).toEqual([{ time: 11, value: 1.5 }, { time: 31, value: 2.5 }]);
  });
});
