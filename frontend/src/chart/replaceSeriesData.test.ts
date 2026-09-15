import { expect, it, vi } from 'vitest';
import { replaceSeriesData } from './replaceSeriesData';

it('clears the old hover before replacing data and preserves the replacement', () => {
  const order: string[] = [];
  const chart = { clearCrosshairPosition: vi.fn(() => order.push('clear')) };
  const series = { setData: vi.fn(() => order.push('replace')) };
  const data: Parameters<typeof replaceSeriesData>[2] = [];
  replaceSeriesData(chart, series, data);
  expect(order).toEqual(['clear', 'replace']);
  expect(series.setData).toHaveBeenCalledWith(data);
});

it('keeps hover during value-only replacements on the same time grid', () => {
  const chart = { clearCrosshairPosition: vi.fn() };
  const series = { setData: vi.fn() };
  const previous = [{ time: '2026-09-15', value: 100 }];
  const data = [{ time: '2026-09-15', value: 101 }];
  replaceSeriesData(chart, series, data, previous);
  expect(chart.clearCrosshairPosition).not.toHaveBeenCalled();
  expect(series.setData).toHaveBeenCalledWith(data);
});

it('clears hover when equal-length stock data moves to different times', () => {
  const chart = { clearCrosshairPosition: vi.fn() };
  const series = { setData: vi.fn() };
  replaceSeriesData(chart, series, [{ time: '2026-09-15', value: 100 }], [{ time: '2026-09-14', value: 100 }]);
  expect(chart.clearCrosshairPosition).toHaveBeenCalledOnce();
});
