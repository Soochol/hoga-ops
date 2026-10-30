import { describe, expect, it } from 'vitest';
import { buildStockClosePoints, stockCloseRange } from './majorIndicesStockModel';
import { seriesValueAt } from './majorIndicesModel';
import { regularSessionOpenMs as open, regularSessionCloseMs as close } from '../liveDateTime';
const date = '20261015', start = open(date);
const bar = (time: number, price: number) => ({ t_ms: time, open: price, high: price, low: price, close: price, volume: 10 });
describe('major indices linked stock', () => {
  it('keeps only positive, finite closes in the selected regular session up to now', () => {
    const points = buildStockClosePoints(date, start + 120_000, [bar(start + 60_000, 200), bar(start, 100),
      bar(start - 60_000, 999), bar(start + 180_000, 999), bar(start + 120_000, NaN), bar(start, -1)], []);
    expect(points).toEqual([{ tMs: start, close: 100 }, { tMs: start + 60_000, close: 200 }]);
    expect(buildStockClosePoints(date, close(date) + 60_000, [bar(close(date), 300), bar(close(date) + 60_000, 999)], [])).toEqual([{ tMs: close(date), close: 300 }]);
  });
  it('updates the REST tail with the newest trade in each minute without overwriting older history', () => {
    const points = buildStockClosePoints(date, start + 180_000, [bar(start, 100), bar(start + 60_000, 200)], [
      { t_ms: start + 60_000, trades: [
        { t_ms: start + 150_000, price: 350, qty: 1, side: 1 },
        { t_ms: start + 130_000, price: 330, qty: 1, side: 1 },
        { t_ms: start + 90_000, price: 250, qty: 1, side: 1 },
        { t_ms: start + 30_000, price: 999, qty: 1, side: 1 },
        { t_ms: start + 240_000, price: 999, qty: 1, side: 1 },
      ] },
    ]);
    expect(points.map(p => p.close)).toEqual([100, 250, 350]);
  });
  it('supports a live-only point and leaves gaps or missing endpoints blank on hover', () => {
    expect(buildStockClosePoints(date, start + 60_000, [], [{ t_ms: start + 30_000, trades: [{ price: 123, qty: 1, side: 1 }] }]))
      .toEqual([{ tMs: start, close: 123 }]);
    const points = [{ tMs: start, close: 100 }, { tMs: start + 60_000, close: 200 }, { tMs: start + 240_000, close: 300 }];
    expect(seriesValueAt(points, start + 30_000, p => p.close)).toBe(150);
    expect(seriesValueAt(points, start + 120_000, p => p.close)).toBeNull();
    expect(seriesValueAt(points, start + 300_000, p => p.close)).toBeNull();
    expect(seriesValueAt(points, start + 30_000, p => p.close, 0)).toBeNull();
  });
  it('fits prices independently and keeps flat or empty data finite', () => {
    expect(stockCloseRange([])).toBeNull();
    expect(stockCloseRange([{ tMs: start, close: 100_000 }, { tMs: start + 60_000, close: 200_000 }]))
      .toEqual({ min: 95_000, max: 205_000 });
    expect(stockCloseRange([{ tMs: start, close: 100 }])).toEqual({ min: 99, max: 101 });
  });
});
