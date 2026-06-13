import { describe, it, expect } from 'vitest';
import { computeDailyMaByDate } from './dailyMovingAverage';
import { unixMsToKSTDate } from '../../util/time';
import type { LivePastDailyCandle } from '../../api/livePastDailyCandles';

const DAY = 86_400_000;
const D0 = 1779235200000; // 2026-05-20 09:00 KST (00:00 UTC)

function daily(closes: number[]): LivePastDailyCandle[] {
  return closes.map((c, i) => ({ t_ms: D0 + i * DAY, open: c, high: c, low: c, close: c, volume: 0 }));
}

describe('computeDailyMaByDate', () => {
  it('keys by the 09:00-KST-anchored trading date', () => {
    const m = computeDailyMaByDate(
      [{ t_ms: 1781222400000, open: 1, high: 1, low: 1, close: 1, volume: 0 }],
      1, 'close', '20260101', null,
    );
    expect(m.has('20260612')).toBe(true); // 1781222400000 → 2026-06-12 KST
  });

  it('returns SMA per date with leading nulls dropped from the map', () => {
    const m = computeDailyMaByDate(daily([10, 20, 30, 40]), 3, 'close', '20260101', null);
    const d = [0, 1, 2, 3].map((i) => unixMsToKSTDate(D0 + i * DAY));
    expect(m.has(d[0])).toBe(false);
    expect(m.has(d[1])).toBe(false);
    expect(m.get(d[2])).toBe(20); // (10+20+30)/3
    expect(m.get(d[3])).toBe(30); // (20+30+40)/3
  });

  it('overrides today row value with live close when daily includes today', () => {
    const todayDate = unixMsToKSTDate(D0 + DAY);
    const m = computeDailyMaByDate(daily([10, 20]), 2, 'close', todayDate, 50);
    expect(m.get(todayDate)).toBe(30); // values [10,50] → SMA(2) last = 30
  });

  it('appends a synthetic today row when daily lacks today', () => {
    const todayDate = unixMsToKSTDate(D0 + 2 * DAY);
    const m = computeDailyMaByDate(daily([10, 20]), 3, 'close', todayDate, 30);
    expect(m.get(todayDate)).toBe(20); // values [10,20,30] → SMA(3) last = 20
  });

  it('does not override when todayLiveClose is null', () => {
    const todayDate = unixMsToKSTDate(D0 + DAY);
    const m = computeDailyMaByDate(daily([10, 20]), 1, 'close', todayDate, null);
    expect(m.get(todayDate)).toBe(20);
  });

  it('sorts daily ascending before computing (defensive)', () => {
    const m = computeDailyMaByDate(daily([10, 20, 30]).slice().reverse(), 2, 'close', '20260101', null);
    expect(m.get(unixMsToKSTDate(D0 + DAY))).toBe(15);     // (10+20)/2
    expect(m.get(unixMsToKSTDate(D0 + 2 * DAY))).toBe(25); // (20+30)/2
  });

  it('returns empty map when period exceeds row count', () => {
    expect(computeDailyMaByDate(daily([10, 20]), 5, 'close', '20260101', null).size).toBe(0);
  });

  it('honors source (hl2)', () => {
    const m = computeDailyMaByDate(
      [{ t_ms: D0, open: 10, high: 14, low: 6, close: 12, volume: 0 }],
      1, 'hl2', '20260101', null,
    );
    expect(m.get(unixMsToKSTDate(D0))).toBe(10); // (14+6)/2
  });
});
