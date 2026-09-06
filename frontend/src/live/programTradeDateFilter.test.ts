import { describe, expect, it } from 'vitest';
import { filterProgramTradeForCandles } from './buildLiveBundle';
import type { Candle, ProgramTradeSeries } from '../api/types';
const DAY = 86_400_000;
const T = Date.UTC(2026, 4, 1, 15); // KST 5월 2일 자정
const c = (ts_ms: number): Candle => ({ ts_ms, open: 1, high: 1, low: 1, close: 1, vol_a: 1, vol_b: 1 });
const series: ProgramTradeSeries = { source: 'kis_program_trade', points: [T - 1, T, T + DAY, T + 2 * DAY].map(t => ({t, net_amount: t, net_qty: 0, gap_risk: false})) };
describe('program trade candle-date cache', () => {
  it('reuses filtered points across changed candles on the same KST dates', () => {
    const first = filterProgramTradeForCandles(series, [c(T)]);
    expect(first.points).toEqual([series.points[1]]);
    const next = filterProgramTradeForCandles({ ...series }, [c(T + 60_000), c(T + 120_000)]);
    expect(next.points).toBe(first.points);
    expect(next.source).toBe(series.source);
  });
  it('detects changed middle dates even when the date range endpoints stay the same', () => {
    const first = filterProgramTradeForCandles(series, [c(T - 1), c(T + 2 * DAY)]);
    const backfilled = filterProgramTradeForCandles(series, [c(T + DAY), c(T + 2 * DAY), c(T - 1)]);
    expect(first.points).toEqual([series.points[0], series.points[3]]);
    expect(backfilled.points).toEqual([series.points[0], series.points[2], series.points[3]]);
    expect(filterProgramTradeForCandles(series, [c(T - 1), c(T + 2 * DAY)]).points).toEqual(first.points);
  });
  it('invalidates on same-length history correction and does not retain data without candles', () => {
    filterProgramTradeForCandles(series, [c(T)]);
    const corrected = { ...series, points: series.points.map(p => p.t === T ? { ...p, net_amount: 999 } : p) };
    expect(filterProgramTradeForCandles(corrected, [c(T)]).points[0].net_amount).toBe(999);
    expect(filterProgramTradeForCandles(corrected, []).points).toEqual([]);
    expect(filterProgramTradeForCandles(undefined, [c(T)]).points).toEqual([]);
  });
});
