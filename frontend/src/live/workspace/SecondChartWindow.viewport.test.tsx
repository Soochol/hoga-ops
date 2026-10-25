import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { useSecondViewport } from './useSecondViewport';
import { secondChartBundle } from './secondChartBundle';

const start = Date.parse('2026-10-23T09:00:00+09:00');
const bars = Array.from({ length: 300 }, (_, i) => ({ t_ms: start + i * 30_000,
  open: 100, high: 110, low: 90, close: 105, volume: 10, count: 1, trade_value: 1000 }));
const candles = secondChartBundle('005930', '20261023', 30, bars).candles;
function mockChart() {
  const range = { from: 90.25, to: 105.25 };
  const scale = { getVisibleLogicalRange: () => range, options: () => ({ barSpacing: 18 }),
    setVisibleLogicalRange: vi.fn(), applyOptions: vi.fn() };
  return { scale, chart: { timeScale: () => scale } as unknown as IChartApi };
}

it('retains the time anchor and zoom through an empty filter page and back', () => {
  const { chart, scale } = mockChart();
  const view = renderHook(({ data }) => useSecondViewport(chart, data), { initialProps: { data: candles } });
  act(() => view.rerender({ data: [] }));
  expect(scale.setVisibleLogicalRange).not.toHaveBeenCalled();
  act(() => view.rerender({ data: candles.slice(60) }));
  expect(scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 30.25, to: 45.25 });
  expect(scale.applyOptions).toHaveBeenLastCalledWith({ barSpacing: 18 });
  view.unmount();
});

it('preserves the visible time after historical prepend, without moving on a tail correction', () => {
  const { chart, scale } = mockChart();
  const view = renderHook(({ data }) => useSecondViewport(chart, data), { initialProps: { data: candles.slice(60) } });
  view.rerender({ data: candles });
  expect(scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 150.25, to: 165.25 });
  scale.setVisibleLogicalRange.mockClear();
  view.rerender({ data: [...candles.slice(0, -1), { ...candles.at(-1)!, close: 106 }] });
  expect(scale.setVisibleLogicalRange).not.toHaveBeenCalled();
  view.unmount();
});

it('does not restore a previous chart viewport onto a new chart instance', () => {
  const first = mockChart(), second = mockChart();
  const view = renderHook(({ chart, data }) => useSecondViewport(chart, data), { initialProps: { chart: first.chart, data: candles } });
  view.rerender({ chart: second.chart, data: candles.slice(60) });
  expect(second.scale.setVisibleLogicalRange).not.toHaveBeenCalled();
  view.unmount();
});

it('adapts only observed trades and leaves slower data sources empty', () => {
  const bundle = secondChartBundle('005930', '20261023', 1, [bars[0], bars[10]]);
  expect(bundle.candles.map(c => c.ts_ms)).toEqual([bars[0].t_ms, bars[10].t_ms]);
  expect(bundle.candles.map(c => c.vol_a + c.vol_b)).toEqual([10, 10]);
  expect(bundle.bucket_ms).toBe(1000);
  expect(bundle.quote_ratio.points).toEqual([]);
  expect(bundle.fill_strength.points).toEqual([]);
  expect(bundle.segments).toEqual([{ date: '20261023', session_open_ms: start, session_close_ms: bars[10].t_ms }]);
});
