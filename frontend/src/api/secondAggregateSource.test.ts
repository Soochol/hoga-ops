import { describe, expect, it } from 'vitest';
import { applySecondDelta, projectSecondSource } from './secondAggregateSource';
import type { SecondAggregates, SecondBar } from './secondAggregates';
const bar = (t_ms: number, close = 100): SecondBar => ({ t_ms, open: close, high: close, low: close, close, volume: 2, count: 1, trade_value: close * 2 });
const source = (bars: SecondBar[]): SecondAggregates => ({ code: '005930', venue: 'KRX', date: '20260930', seconds: 1, source: 'second_trades', status: 'observed', coverage: 'unverified', storage_error: null, first_observed_ms: 0, last_observed_ms: 30000, bars, prices: [], revision: 'initial', reset: true });
describe('shared seconds source', () => {
  it('replaces late corrections, removes price cells, inserts and deletes buckets without adding quantities twice', () => {
    const before = { ...source([bar(1000), bar(2000), bar(4000)]), prices: [
      { t_ms: 1000, price: 100, qty: 2, side: 1 as const, count: 1 },
      { t_ms: 1000, price: 101, qty: 3, side: -1 as const, count: 1 },
      { t_ms: 2000, price: 100, qty: 2, side: 1 as const, count: 1 },
    ] };
    const delta = { ...source([bar(1000, 95), bar(3000)]), reset: false, revision: 'next', changed_ms: [1000, 2000, 3000], prices: [{ t_ms: 1000, price: 95, qty: 5, side: 1 as const, count: 2 }] };
    const next = applySecondDelta(before, delta);
    expect(next.bars.map(b => [b.t_ms, b.close])).toEqual([[1000, 95], [3000, 100], [4000, 100]]);
    expect(next.prices).toEqual(delta.prices);
    expect(next.bars.at(-1)).toBe(before.bars.at(-1));
    expect(applySecondDelta(next, delta).bars).toEqual(next.bars);
  });
  it('accepts reset/source replacement and preserves array identities on empty deltas', () => {
    const before = source([bar(1000)]);
    const unchanged = applySecondDelta(before, { ...source([]), reset: false, changed_ms: [], revision: 'initial' });
    expect(unchanged.bars).toBe(before.bars);
    expect(unchanged.prices).toBe(before.prices);
    expect(projectSecondSource(unchanged, 10, null, false).bars).toBe(projectSecondSource(before, 10, null, false).bars);
    const reset = { ...source([bar(3000)]), revision: 'restart' };
    expect(applySecondDelta(before, reset)).toBe(reset);
    const legacy = source([bar(5000)]); delete legacy.revision;
    expect(applySecondDelta(before, legacy)).toBe(legacy);
  });
  it('reprojects only corrected buckets and retains untouched projected bar objects', () => {
    let closeReads = 0;
    const before = source(Array.from({ length: 10000 }, (_, i) => ({ ...bar(i * 1000), get close() { closeReads++; return 100 + i % 7; } })));
    const oldProjection = projectSecondSource(before, 10, null, false);
    closeReads = 0;
    const next = applySecondDelta(before, { ...source([bar(5000, 90), bar(10000000, 120)]),
      revision: 'next', reset: false, changed_ms: [5000, 10000000] });
    const incremental = projectSecondSource(next, 10, null, false);
    expect(closeReads).toBeLessThan(20);
    const complete = projectSecondSource({ ...next, bars: [...next.bars] }, 10, null, false);
    expect(incremental.bars).toEqual(complete.bars);
    expect(incremental.bars[1]).toBe(oldProjection.bars[1]);
    expect(incremental.bars[0]).not.toBe(oldProjection.bars[0]);
  });
  it.each([1, 5, 10, 30] as const)('projects %s seconds with ordered OHLC and exact volume', seconds => {
    const start = Date.parse('2026-09-30T09:00:00+09:00');
    const raw = source([bar(start, 100), bar(start + 1000, 110), bar(start + 4000, 90), bar(start + 30000, 95)]);
    const projected = projectSecondSource(raw, seconds, null, true);
    expect(projected.bars.reduce((sum, b) => sum + b.volume, 0)).toBe(8);
    if (seconds > 1) expect(projected.bars[0]).toMatchObject({ open: 100, close: 90, high: 110, low: 90, volume: 6 });
    expect(projected.prices).toBe(raw.prices);
    expect(projectSecondSource(raw, seconds, start + 30000, false).bars).toEqual([bar(start + 30000, 95)]);
  });
});
