import { describe, expect, it } from 'vitest';
import { filterRegularSession, regularSessionHogaForDisplay } from './regularSessionView';
import { aggregateCandles, keepRegularSessionCandles } from './aggregateCandles';
import { fetchBucketMsFor } from '../state/livePage';
import type { QuoteRatioPoint, RangeBundle } from '../api/types';
import { bucketHogaSeries } from './bucketHogaSeries';
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

const quote = (time: string, bid: number, ask: number): QuoteRatioPoint => ({
  t: at(time), bid_total: bid, ask_total: ask, bid_max: bid, ask_max: ask,
  imb_max_bid: bid, imb_max_ask: ask, band_pct: 0, tick: 0,
});
const hogaBundle = (points: QuoteRatioPoint[]): RangeBundle => ({
  code: '005930', from_date: '20261001', to_date: '20261001', bucket_ms: 60_000,
  segments: [], candles: [], quote_ratio: { bucket_ms: 60_000, points },
  fill_strength: { bucket_ms: 60_000, points: points.map(p => ({ t: p.t, buy_qty: 2, sell_qty: 3 })) },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [], volume_distributions: [], investorPoints: [], ask_peaks: [], broker_late_entries: [], excluded_dates: [], data_warnings: [],
});

describe('regular-session hoga display grid', () => {
  it.each([3, 5, 10, 60, 120])('matches live hoga aggregation on a %im grid', minutes => {
    const source = hogaBundle([
      quote('08:59:00', 9999, 1), quote('09:00:00', 100, 10),
      quote('09:01:00', 150, 50), quote('09:02:00', 80, 160),
      quote('09:03:00', 100, 50), quote('15:30:00', 10, 10), quote('15:31:00', 9999, 1),
    ]);
    const kept = source.quote_ratio.points.filter(p => p.t >= at('09:00:00') && p.t <= at('15:30:00'));
    const expected = bucketHogaSeries(
      kept.map(p => ({ t_ms: p.t, total_bid_qty: p.bid_total, total_ask_qty: p.ask_total })),
      kept.map(p => ({ t_ms: p.t, trades: [{ side: 1, qty: 2 }, { side: -1, qty: 3 }] })),
      minutes * 60_000,
    );
    for (const venue of ['KRX', 'NXT', 'UN']) {
      const result = regularSessionHogaForDisplay(source, minutes * 60_000, venue)!;
      expect(result.quote_ratio.points).toEqual(expected.quoteRatioPoints);
      expect(result.fill_strength.points).toEqual(expected.fillStrengthPoints);
      expect(result.bucket_ms).toBe(minutes * 60_000);
      expect(result.quote_ratio.bucket_ms).toBe(result.bucket_ms);
      expect(result.fill_strength.bucket_ms).toBe(result.bucket_ms);
    }
    expect(source.quote_ratio.points).toHaveLength(7);
  });

  it('keeps the last continuous book before zero auction sentinels, its maxima, and earliest imbalance tie', () => {
    const source = hogaBundle([
      quote('15:27:00', 30, 10), quote('15:28:00', 10, 30), quote('15:29:00', 0, 0),
    ]);
    source.quote_ratio.points[1].band_pct = 1.5;
    source.quote_ratio.points[1].tick = 100;
    const result = regularSessionHogaForDisplay(source, 3 * 60_000, 'KRX')!;
    expect(result.quote_ratio.points).toEqual([{
      ...source.quote_ratio.points[1], t: at('15:27:00'), bid_max: 30, ask_max: 30,
      imb_max_bid: 30, imb_max_ask: 10,
    }]);
    expect(result.fill_strength.points).toEqual([{ t: at('15:27:00'), buy_qty: 6, sell_qty: 9 }]);
  });

  it('preserves already aligned series references and empty inputs', () => {
    const source = hogaBundle([quote('09:00:00', 30, 10)]);
    expect(regularSessionHogaForDisplay(source, 60_000, 'KRX')).toBe(source);
    expect(regularSessionHogaForDisplay(null, 180_000, 'KRX')).toBeNull();
  });
});
