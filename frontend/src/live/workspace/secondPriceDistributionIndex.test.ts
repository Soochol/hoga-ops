import { expect, it } from 'vitest';
import type { SecondAggregates, SecondPrice } from '../../api/secondAggregates';
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

it('incrementally matches full profiles after append, quantity/extrema corrections and deletions', async () => {
  const { applySecondDelta } = await import('../../api/secondAggregateSource');
  const { createSecondPriceDistributionCache } = await import('./secondPriceDistributionIndex');
  const open = Date.parse('2026-09-30T09:00:00+09:00');
  const cell = (t_ms: number, price: number, qty = 1, side: -1 | 0 | 1 = 1): SecondPrice => ({ t_ms, price, qty, side, count: 1 });
  let source: SecondAggregates = { code: '005930', venue: 'KRX' as const, date: '20260930', seconds: 1 as const,
    source: 'second_trades' as const, status: 'observed' as const, coverage: 'unverified' as const,
    storage_error: null, first_observed_ms: open, last_observed_ms: open, bars: [],
    prices: [cell(open, 90), cell(open, 100, 2, -1), cell(open + 1000, 120), cell(open + 2000, 105)],
    revision: 'a', reset: true, changed_ms: [] as number[] };
  const cache = createSecondPriceDistributionCache();
  let previousIndex = cache.update(source.prices, '20260930', 10);
  for (const [changed, prices] of [
    [[open + 3000], [cell(open + 3000, 130)]],
    [[open + 3000], [cell(open + 3000, 125, 99)]],
    [[open], [cell(open, 95, 3), cell(open, 300, 9, 0)]],
    [[open + 1000], []],
    [[open + 1000, open + 3000], [cell(open + 1000, 200, 2, -1)]],
    [[open - 1000], [cell(open - 1000, 400)]],
    [[open, open + 1000, open + 2000], []],
  ] as [number[], SecondPrice[]][]) {
    source = applySecondDelta(source, { ...source, reset: false, revision: source.revision + 'b',
      changed_ms: changed, prices, bars: [] });
    const index = cache.update(source.prices, '20260930', 10);
    expect(index).toBe(previousIndex);
    for (const cutoff of [open, open + 1, open + 1001, open + 2001, open + 3001, null]) {
      expect(index.profileAt(cutoff)).toEqual(secondPriceDistribution(
        cutoff === null ? source.prices : source.prices.filter(p => p.t_ms < cutoff), '20260930', 10));
    }
    previousIndex = index;
  }
  const nextDay = cache.update(source.prices, '20261001', 10);
  expect(nextDay).not.toBe(previousIndex); expect(nextDay.profileAt()).toBeNull();
  expect(cache.update(source.prices, '20260930', 20).profileAt()).toEqual(secondPriceDistribution(source.prices, '20260930', 20));
});

it('reads only changed tail cells on a delta and rebuilds safely after a skipped revision or reset', async () => {
  const { applySecondDelta } = await import('../../api/secondAggregateSource');
  const { createSecondPriceDistributionCache } = await import('./secondPriceDistributionIndex');
  let reads = 0;
  const open = Date.parse('2026-09-30T09:00:00+09:00');
  const source = { code: '005930', venue: 'KRX' as const, date: '20260930', seconds: 1 as const,
    source: 'second_trades' as const, status: 'observed' as const, coverage: 'unverified' as const,
    storage_error: null, first_observed_ms: open, last_observed_ms: open, bars: [], revision: 'a', reset: true,
    changed_ms: [], prices: Array.from({ length: 5000 }, (_, i) => ({ t_ms: open + i * 1000,
      get price() { reads++; return 100 + i % 10; }, qty: 1, count: 1, side: 1 as const })) };
  const cache = createSecondPriceDistributionCache();
  cache.update(source.prices, '20260930', 10); reads = 0;
  const t = open + 5000_000;
  const appended = applySecondDelta(source, { ...source, reset: false, revision: 'b', changed_ms: [t],
    prices: [{ t_ms: t, price: 200, qty: 2, side: 1, count: 1 }] });
  const index = cache.update(appended.prices, '20260930', 10);
  expect(reads).toBe(0); expect(index.profileAt()?.price_max).toBe(200);
  const skipped = applySecondDelta(appended, { ...appended, revision: 'c', changed_ms: [t], prices: [] });
  const afterSkipped = applySecondDelta(skipped, { ...skipped, revision: 'd', changed_ms: [open], prices: [] });
  const rebuilt = cache.update(afterSkipped.prices, '20260930', 10);
  expect(rebuilt).not.toBe(index);
  expect(rebuilt.profileAt()).toEqual(secondPriceDistribution(afterSkipped.prices, '20260930', 10));
  const reset = { ...afterSkipped, reset: true, prices: [{ t_ms: open, price: 50, qty: 3, side: 1 as const, count: 1 }] };
  expect(cache.update(reset.prices, '20260930', 10).profileAt()?.price_max).toBe(50);
});

it('handles multiple historical bucket insertions and removals without stale prefixes', async () => {
  const { applySecondDelta } = await import('../../api/secondAggregateSource');
  const { createSecondPriceDistributionCache } = await import('./secondPriceDistributionIndex');
  const open = Date.parse('2026-09-30T09:00:00+09:00');
  const close = Date.parse('2026-09-30T15:30:00+09:00');
  const times = [open - 1000, ...Array.from({ length: 15 }, (_, i) => open + i * 1000),
    close, close + 1000, close + 30 * 60_000];
  let source: SecondAggregates = { code: '005930', venue: 'KRX', date: '20260930', seconds: 1,
    source: 'second_trades', status: 'observed', coverage: 'unverified', storage_error: null,
    first_observed_ms: open, last_observed_ms: close, bars: [], prices: [], revision: '0' };
  const cache = createSecondPriceDistributionCache();
  cache.update(source.prices, source.date, 7);
  let seed = 72;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  for (let step = 0; step < 60; step++) {
    const changed = [...new Set(Array.from({ length: 5 }, () => times[random() % times.length]))].sort((a, b) => a - b);
    const updates = changed.flatMap(t_ms => Array.from({ length: random() % 4 }, () => ({
      t_ms, price: 90 + random() % 50, qty: random() % 20 + 1, count: 1, side: (random() % 3 - 1) as -1 | 0 | 1,
    })));
    source = applySecondDelta(source, { ...source, reset: false, revision: String(step + 1), changed_ms: changed, prices: updates });
    const index = cache.update(source.prices, source.date, 7);
    for (const cutoff of [open, open + 1, open + 6001, open + 14001, close, close + 1, close + 1800001, null]) {
      expect(index.profileAt(cutoff)).toEqual(secondPriceDistribution(
        cutoff === null ? source.prices : source.prices.filter(p => p.t_ms < cutoff), source.date, 7));
    }
  }
});
