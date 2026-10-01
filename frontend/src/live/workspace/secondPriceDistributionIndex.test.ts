import { expect, it } from 'vitest';
import type { SecondPrice } from '../../api/secondAggregates';
import { buildSecondPriceDistributionIndex } from './secondPriceDistributionIndex';
import { secondPriceDistribution } from './secondAggregateProjectors';

it('matches full recomputation with changing prefix extrema, gaps, duplicate times and closing trades', () => {
  const open = Date.parse('2026-09-30T09:00:00+09:00');
  const close = Date.parse('2026-09-30T15:30:00+09:00');
  const prices: SecondPrice[] = Array.from({ length: 1000 }, (_, i) => ({
    t_ms: open + Math.floor(i / 3) * 1000, price: 100 + (i * 37 % 91), side: i % 7 === 0 ? 0 : i % 2 ? 1 : -1, qty: i % 13 + 1, count: 1,
  }));
  prices.push({t_ms: close,price: 200,side: 1,qty: 99,count: 1}, {t_ms: close+1000,price: 500,side: 1,qty: 10,count: 1});
  prices.reverse();
  for (const bins of [1, 10, 31]) {
    const index = buildSecondPriceDistributionIndex(prices, '20260930', bins);
    for (const cutoff of [open-1, open, open+1, ...Array.from({length: 60}, (_, i) => open+i*7000), close, close+1, null]) {
      const expected = secondPriceDistribution(cutoff === null ? prices : prices.filter(p => p.t_ms < cutoff), '20260930', bins);
      expect(index.profileAt(cutoff)).toEqual(expected);
    }
  }
});

it('never rereads original price cells while querying cursor prefixes', () => {
  let reads = 0;
  const open = Date.parse('2026-09-30T09:00:00+09:00');
  const prices: SecondPrice[] = Array.from({length: 4500}, (_, i) => ({
    t_ms: open+i*1000, get price() { reads++; return 100+i%20; }, side: 1, qty: 1, count: 1,
  }));
  const index = buildSecondPriceDistributionIndex(prices, '20260930', 10);
  reads = 0;
  for (let i=0; i<60; i++) index.profileAt(open+i*1000);
  expect(reads).toBe(0);
});
