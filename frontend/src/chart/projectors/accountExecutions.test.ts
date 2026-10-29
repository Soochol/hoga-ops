import { describe, expect, it } from 'vitest';
import { createVirtualAxis } from '../../util/virtualAxis';
import type { AccountExecution } from '../../api/accountExecutions';
import type { Candle } from '../../api/types';
import { layoutExecutionMarkers, projectAccountExecutions } from './accountExecutions';

const date = '20261019', start = Date.parse('2026-10-19T09:00:00+09:00');
const candle = (ts_ms: number, close = 100): Candle => ({ ts_ms, open: close, high: close + 10, low: close - 10, close, vol_a: 10, vol_b: 0 });
const fill = (id: string, minute = 3, side: 'BUY' | 'SELL' = 'BUY', price = '100'): AccountExecution => ({
  execution_id: id, order_ref: 'order', code: '005930', trading_date: date, t_ms: start + minute * 60_000 + 25_000,
  side, price, quantity: '10', venue: 'KRX', basis: 'execution',
});
const segment = { date, sessionOpenMs: start, sessionCloseMs: start + 23_400_000 };

describe('individual account execution projection', () => {
  it('anchors minute fills to their actual containing candle; missing bars are never snapped to neighbors', () => {
    const axis = createVirtualAxis([segment]);
    const candles = [candle(start), candle(start + 180_000), candle(start + 360_000)];
    const result = projectAccountExecutions([fill('a'), fill('b', 4), fill('c', 9)], candles, axis, '3m', { [date]: 1 }, {}, date);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].executions.map(r => r.execution_id)).toEqual(['a', 'b']);
    expect(result.markers[0].time).toBe(axis.toVirtual(start + 180_000) / 1000);
    expect(result.unmatched.map(r => r.execution_id)).toEqual(['c']);
  });
  it('keeps separate price/side markers and groups equal-price fills without a count label', () => {
    const axis = createVirtualAxis([segment]);
    const result = projectAccountExecutions([fill('a'), fill('b'), fill('c', 3, 'SELL'), fill('d', 3, 'BUY', '110')],
      [candle(start + 180_000)], axis, '1m', { [date]: 1 }, {}, date);
    expect(result.markers).toHaveLength(3);
    expect(result.markers[0].executions).toHaveLength(2);
    expect(result.markers.every(m => m.barExecutions.length === 4)).toBe(true);
    const positions = layoutExecutionMarkers(result.markers.map(m => ({ marker: m, x: 100, y: m.price })), 300, 300);
    expect(positions.map(p => [p.x, p.y])).toEqual([[100, 100], [100, 100], [100, 110]]);
  });
  it('uses the displayed daily close and verified original close for that exact day', () => {
    const axis = createVirtualAxis([segment], start, { mode: 'calendar' });
    const result = projectAccountExecutions([fill('a', 3, 'BUY', '1000')], [candle(start, 500)], axis,
      'D', undefined, { [date]: 1000 }, '20261028');
    expect(result.markers[0].price).toBe(500);
    expect(result.markers[0].time).toBe(axis.toVirtual(start) / 1000);
    expect(result.markers[0].executions[0].price).toBe('1000');
  });
  it('preserves fractional order average prices at the last fill candle in minute and adjusted daily views', () => {
    const row: AccountExecution = { ...fill('order', 4, 'SELL', '100.75'), basis: 'order_average' };
    const axis = createVirtualAxis([segment]);
    const minute = projectAccountExecutions([row], [candle(start + 180_000)], axis, '3m', undefined, {}, date);
    expect(minute.markers[0].price).toBe(100.75);
    expect(minute.markers[0].time).toBe(axis.toVirtual(start + 180_000) / 1000);
    const daily = projectAccountExecutions([row], [candle(start, 50)], axis, 'D', undefined, { [date]: 100 }, '20261028');
    expect(daily.markers[0].price).toBe(50.375);
    expect(daily.markers[0].executions[0].basis).toBe('order_average');
  });
  it('does not invent an adjustment factor or place an out-of-session fill on an available bar', () => {
    const axis = createVirtualAxis([segment], start, { mode: 'calendar' });
    expect(projectAccountExecutions([fill('a')], [candle(start)], axis, 'D', undefined, {}, '20261028').unscaled).toHaveLength(1);
    const intraday = createVirtualAxis([segment]);
    expect(projectAccountExecutions([fill('a')], [candle(start + 180_000)], intraday, '1m', {}, {}, '20261028').unscaled).toHaveLength(1);
    const outside = { ...fill('outside'), t_ms: start - 60_000 };
    expect(projectAccountExecutions([outside], [candle(start)], intraday, '1m', undefined, {}, date).unmatched).toHaveLength(1);
    const late = { ...fill('late'), t_ms: start + 8 * 3_600_000 };
    expect(projectAccountExecutions([late], [candle(start + 6 * 3_600_000)], intraday,
      '240m', undefined, {}, date).unmatched).toHaveLength(1);
  });
});

describe('fixed-size execution label positions', () => {
  const marker = (time = 1, side: 'BUY' | 'SELL' = 'BUY') => ({ time: time as import('lightweight-charts').Time,
    side, price: 100, executions: [], barExecutions: [] });
  const point = (y: number, time = 1, side: 'BUY' | 'SELL' = 'BUY', x = 100) => ({ marker: marker(time, side), x, y });

  it('keeps nearby prices and both directions exactly at their candle and price coordinates', () => {
    const points = [point(100), point(105), point(100, 1, 'SELL'), point(113), point(114), point(101, 2, 'BUY', 101)];
    const result = layoutExecutionMarkers(points, 300, 300);
    expect(result).toEqual(points);
    expect(result).toHaveLength(6);
    expect(result[0]).toBe(points[0]);
  });
  it('does not omit any labels in a dense cluster of neighboring candles', () => {
    const points = Array.from({ length: 1000 }, (_, i) => point(100 + i % 3, i + 1, i % 2 ? 'BUY' : 'SELL', 100 + (i % 10) * .5));
    expect(layoutExecutionMarkers(points, 300, 300)).toEqual(points);
  });
  it('preserves exact coordinates and input order on an inverted price scale', () => {
    const points = [point(200), point(180), point(200, 1, 'SELL')];
    expect(layoutExecutionMarkers(points, 300, 300)).toEqual(points);
  });
  it('keeps edge labels and rejects only offscreen or non-finite anchor coordinates', () => {
    const points = [point(0, 1, 'BUY', 0), point(300, 2, 'SELL', 300), point(-1), point(301), point(NaN), point(100, 1, 'BUY', Infinity)];
    expect(layoutExecutionMarkers(points, 300, 300)).toEqual(points.slice(0, 2));
  });
});
