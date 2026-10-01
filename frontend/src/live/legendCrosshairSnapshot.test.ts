import { expect, it } from 'vitest';
import type { MouseEventParams } from 'lightweight-charts';
import { legendCrosshairSnapshot, sameLegendCrosshair } from './legendCrosshairSnapshot';

it('ignores pointer motion within a bar but keeps intrabar values, series removal and leave updates', () => {
  const series = {};
  const value = { time: 100, open: 100, high: 110, low: 90, close: 105 };
  const event = { time: 100, point: { x: 10, y: 10 }, seriesData: new Map([[series, value]]) } as unknown as MouseEventParams;
  const initial = legendCrosshairSnapshot(event);
  expect(sameLegendCrosshair(initial, legendCrosshairSnapshot({ ...event, point: { ...event.point!, y: 100 as NonNullable<MouseEventParams['point']>['y'] } }))).toBe(true);
  value.close = 106; // Also guard mutable point records from chart adapters.
  expect(sameLegendCrosshair(initial, legendCrosshairSnapshot(event))).toBe(false);
  expect(sameLegendCrosshair(initial, legendCrosshairSnapshot({ ...event, time: 101 as MouseEventParams['time'] }))).toBe(false);
  expect(sameLegendCrosshair(initial, legendCrosshairSnapshot({ ...event, seriesData: new Map() }))).toBe(false);
  expect(sameLegendCrosshair(initial, legendCrosshairSnapshot({ ...event, point: undefined }))).toBe(false);
  expect(sameLegendCrosshair(null, legendCrosshairSnapshot({ ...event, point: undefined }))).toBe(true);
});
