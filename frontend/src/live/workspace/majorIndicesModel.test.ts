import { describe, expect, it } from 'vitest';
import { buildMajorIndexSeries, indexPercentAt, latestIndexDate } from './majorIndicesModel';
import type { LiveIndexCandle } from '../../api/liveIndices';
import { regularSessionOpenMs as open, regularSessionCloseMs as close } from '../liveDateTime';
const bar = (date: string, value: number, minute = 0): LiveIndexCandle => ({ t_ms: open(date) + minute * 60_000, open: value, high: value, low: value, close: value, volume: 1 });
const quote = (value: number, change: number, tMs: number) => ({ id: 'KOSPI', label: '코스피', value, change, changeRate: change, tMs });
describe('major index normalization', () => {
  it('uses the previous trading close, including an overnight gap, rather than the first point', () => {
    const result = buildMajorIndexSeries('20261015', open('20261015') + 120_000, [bar('20261015', 103), bar('20261015', 104, 1)], [bar('20261013', 90), bar('20261014', 100)]);
    expect(result.points.map(p => p.percent)).toEqual([expect.closeTo(3), expect.closeTo(4)]);
    expect(result.closed).toBe(false);
  });
  it('uses the matching quote baseline and appends a newer quote', () => {
    const result = buildMajorIndexSeries('20261015', open('20261015') + 120_000, [bar('20261015', 103)], [bar('20261014', 99)], quote(104, 4, open('20261015') + 90_000));
    expect(result.points[0].percent).toBeCloseTo(3);
    expect(result.points.at(-1)?.percent).toBeCloseTo(4);
    expect(result.value).toBe(104);
  });
  it('keeps prices on the selected session and rejects next-day quote stamps on a holiday', () => {
    const result = buildMajorIndexSeries('20261016', open('20261018'), [bar('20261016', 102), bar('20261015', 999)], [bar('20261015', 100), bar('20261016', 105)], quote(999, 1, open('20261018')));
    expect(result.value).toBe(105);
    expect(result.percent).toBeCloseTo(5);
    expect(result.points.at(-1)?.tMs).toBe(close('20261016'));
    expect(result.points).toHaveLength(2);
    expect(result.closed).toBe(true);
  });
  it('does not label a stale pre-close quote as the closing value after 15:30', () => {
    const result = buildMajorIndexSeries('20261015', close('20261015') + 600_000, [bar('20261015', 104, 380)], [bar('20261014', 100)], quote(104, 4, close('20261015') - 600_000));
    expect(result.closed).toBe(false);
    expect(result.delayed).toBe(true);
  });
  it('places the final quote at the regular close, not in the aftermarket', () => {
    const now = close('20261015') + 600_000;
    const result = buildMajorIndexSeries('20261015', now, [bar('20261015', 104, 389)], [], quote(105, 5, now));
    expect(result.closed).toBe(true);
    expect(result.points.at(-1)).toMatchObject({ tMs: close('20261015'), percent: expect.closeTo(5) });
  });
  it('never invents a percent when the previous close is unavailable', () => {
    const result = buildMajorIndexSeries('20261015', open('20261015'), [bar('20261015', 100)], []);
    expect(result.value).toBe(100);
    expect(result.percent).toBeNull();
    expect(result.points).toEqual([]);
  });
  it('finds the most recent valid trading day in unsorted history', () => {
    expect(latestIndexDate([bar('20261014', 100), bar('20261015', NaN), bar('20261013', 99)], '20261018')).toBe('20261014');
  });
  it('interpolates each line at the cursor and leaves missing history blank', () => {
    const points = [{ tMs: 0, percent: 1 }, { tMs: 60_000, percent: 3 }, { tMs: 300_000, percent: 4 }];
    expect(indexPercentAt(points, 30_000)).toBe(2);
    expect(indexPercentAt(points, 120_000)).toBeNull();
    expect(indexPercentAt(points, 310_000)).toBeNull();
  });
});
