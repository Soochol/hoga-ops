import { describe, expect, it } from 'vitest';
import { filterRegularSession } from './regularSessionView';
import { aggregateCandles, keepRegularSessionCandles } from './aggregateCandles';
import { fetchBucketMsFor } from '../state/livePage';
const at = (time: string) => Date.parse(`2026-10-01T${time}+09:00`);

describe('regular-session display', () => {
  it('retains both boundaries across days and removes after-hours indicators', () => {
    const series = { quote_ratio: { points: ['08:59:59', '09:00:00', '15:30:00', '15:30:01', '16:00:00'].map(time => ({ t: at(time), value: 1 })) },
      candles: [{ ts_ms: Date.parse('2026-09-30T09:00:00+09:00'), close: 100 }] };
    const filtered = filterRegularSession(series);
    expect(filtered.quote_ratio.points.map(p => p.t)).toEqual([at('09:00:00'), at('15:30:00')]);
    expect(filtered.candles).toBe(series.candles);
  });
  it('clips before large-bar aggregation so aftermarket prices cannot change OHLC', () => {
    const source = ['15:00:00', '15:30:00', '16:00:00'].map((time, i) => ({ t_ms: at(time), open: 100 + i * 100, high: 100 + i * 100, low: 100 + i * 100, close: 100 + i * 100, volume: 10 }));
    for (const venue of ['KRX', 'NXT', 'UN'] as const) {
      const bars = aggregateCandles(keepRegularSessionCandles(source), 120 * 60, venue);
      expect(bars.at(-1)?.close).toBe(200);
      expect(bars.reduce((sum, b) => sum + b.volume, 0)).toBe(20);
    }
    expect(fetchBucketMsFor('60m', true)).toBe(60_000);
    expect(fetchBucketMsFor('240m', true)).toBe(60_000);
  });
});
