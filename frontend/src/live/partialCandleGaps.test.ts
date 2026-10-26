import { describe, expect, it } from 'vitest';
import type { Candle, RangeSegment } from '../api/types';
import { regularSessionOpenMs } from './liveDateTime';
import { partialCandleGapDates, supplementalCandles } from './partialCandleGaps';

const start = regularSessionOpenMs('20261016');
const minute = 60_000;
const bar = (offset: number, volume = 10): Candle => ({
  ts_ms: start + offset * minute, open: 8100, high: 8200, low: 8000, close: 8150,
  vol_a: volume, vol_b: 0,
});
const session: RangeSegment = { date: '20261016', session_open_ms: start,
  session_close_ms: start + 3 * minute, source: 'hogaplay' };

describe('partial candle gaps', () => {
  it.each([[1, 2, 3], [0, 2, 3], [0, 1, 2]])('checks leading, interior and trailing gaps: %j', (...offsets) => {
    expect(partialCandleGapDates(offsets.map(n => bar(n)), [session], minute)).toEqual(['20261016']);
  });

  it('honors a shortened session and treats zero-volume source bars as present', () => {
    const candles = [0, 1, 2, 3].map(n => bar(n, 0));
    expect(partialCandleGapDates(candles, [session], minute)).toEqual([]);
    expect(partialCandleGapDates(candles, [], minute)).toEqual([]);
  });

  it('compares displayed buckets instead of requiring a minute bar for every multi-minute candle', () => {
    expect(partialCandleGapDates([bar(0), bar(3)], [session], 3 * minute)).toEqual([]);
  });

  it('preserves disk prices and volumes and adds only provider-observed missing buckets', () => {
    const disk = [bar(2)];
    const conflict = { ...bar(2), close: 9999, vol_a: 9999 };
    const zeroVolume = bar(0, 0);
    expect(supplementalCandles(disk, [zeroVolume, conflict, bar(3)], minute))
      .toEqual([zeroVolume, bar(3)]);
    // Minute 1 is absent from both sources: no price or volume is invented.
    expect(disk).toEqual([bar(2)]);
    expect(supplementalCandles([bar(1)], [bar(0)], 3 * minute)).toEqual([]);
  });
});
