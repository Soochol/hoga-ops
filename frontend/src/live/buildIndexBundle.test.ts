import { describe, expect, it } from 'vitest';
import { createVirtualAxis } from '../util/virtualAxis';
import { buildIndexBundle, buildPriceBundle } from './buildIndexBundle';

describe('buildIndexBundle', () => {
  it('preserves actual calendar turnover including zero without inferring missing amounts', () => {
    const bundle = buildIndexBundle({
      indexId: 'KOSDAQ', from: '20260619', to: '20260619', bucketMs: 86_400_000,
      candles: [18840196000000, 0, null, undefined].map((trade_value_won, i) => ({
        t_ms: 1_781_830_800_000 + i * 1000, open: 2800, high: 2800, low: 2800,
        close: 2800, volume: 450000000, trade_value_won,
      })),
    });
    expect(bundle.candles.map(c => c.trade_value_won)).toEqual([18840196000000, 0, undefined, undefined]);
  });

  it('converts index candles into a hoga-free RangeBundle', () => {
    const bundle = buildIndexBundle({
      indexId: 'KOSPI',
      from: '20260619',
      to: '20260619',
      bucketMs: 86_400_000,
      candles: [
        { t_ms: 1_781_830_800_000, open: 2840.12, high: 2861.34, low: 2833.2, close: 2855.67, volume: 450000000 },
      ],
      investorPoints: [
        { t_ms: 1_781_830_800_000, foreign_net: -3519, institution_net: 17184 },
      ],
    });

    expect(bundle.code).toBe('index:KOSPI');
    expect(bundle.candles).toEqual([
      { ts_ms: 1_781_830_800_000, open: 2840.12, high: 2861.34, low: 2833.2, close: 2855.67, vol_a: 450000000, vol_b: 0 },
    ]);
    expect(bundle.quote_ratio.points).toEqual([]);
    expect(bundle.fill_strength.points).toEqual([]);
    expect(bundle.investorPoints).toEqual([
      { t_ms: 1_781_830_800_000, foreign_net: -3519, institution_net: 17184 },
    ]);
    expect(bundle.ask_peaks).toEqual([]);
    expect(bundle.broker_late_entries).toEqual([]);
    expect(bundle.segments[0].date).toBe('20260619');
  });
});


it.each(['NASDAQ_COMPOSITE', 'SP500', 'SOX'] as const)('%s minute candles survive KST midnight with real NY session instants', indexId => {
  // NY July 10 10:59 / 11:00 = KST July 10 23:59 / July 11 00:00.
  const start = Date.UTC(2026, 6, 10, 14, 59);
  const bundle = buildIndexBundle({ indexId, from: '20260710', to: '20260710', bucketMs: 60_000,
    candles: [0, 1, 2].map(i => ({ trading_date: '20260710', t_ms: start + i * 60_000, open: 120.1, high: 125, low: 119, close: 121.2345, volume: 0 })) });
  expect(bundle.segments).toEqual([{ date: '20260710', session_open_ms: start, session_close_ms: start + 3 * 60_000 }]);
  const axis = createVirtualAxis(bundle.segments.map(s => ({ date: s.date, sessionOpenMs: s.session_open_ms, sessionCloseMs: s.session_close_ms })), start);
  for (const candle of bundle.candles) {
    expect(axis.classifyAndProject(candle.ts_ms).contained).toBe(true);
    expect(axis.toReal(axis.toVirtual(candle.ts_ms))).toBe(candle.ts_ms);
  }
  expect(bundle.candles.at(-1)?.close).toBe(121.2345);
});


it('keeps native US overnight sessions disjoint at adjacent hourly business-day boundaries', () => {
  const first = Date.UTC(2026, 9, 15, 7); // NY 03:00, represented as prior business day 27:00
  const bundle = buildPriceBundle({ code: 'us-stock:NASDAQ:NVDA', from: '20261014', to: '20261015', bucketMs: 3_600_000, observedSessions: true,
    candles: [{ trading_date: '20261014', t_ms: first, open: 120, high: 125, low: 119, close: 121, volume: 1 },
      { trading_date: '20261014', t_ms: first + 59 * 60_000, open: 121, high: 125, low: 119, close: 122, volume: 2 },
      { trading_date: '20261015', t_ms: first + 3_600_000, open: 121, high: 125, low: 119, close: 122, volume: 2 }] });
  expect(bundle.segments[0].session_close_ms).toBeLessThan(bundle.segments[1].session_open_ms);
  const axis = createVirtualAxis(bundle.segments.map(s => ({ date: s.date, sessionOpenMs: s.session_open_ms, sessionCloseMs: s.session_close_ms })), first);
  for (const row of bundle.candles) {
    expect(axis.contains(row.ts_ms)).toBe(true);
    expect(axis.toReal(axis.toVirtual(row.ts_ms))).toBe(row.ts_ms);
  }
});
