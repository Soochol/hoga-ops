import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { TradeBrowseCrosshair } from './TradeBrowseCrosshair';
import type { VirtualAxis } from '../util/virtualAxis';
import type { PaneSeriesMap } from './drawing/chartCoordinates';
import { useTradeBrowseStore } from '../live/tradeBrowse';
import { hasSyntheticCrosshair, releaseSyntheticCrosshair } from './syntheticCrosshair';

const T = Date.parse('2026-09-29T09:31:00+09:00');
function scene(x = 50, logical = 110, enabled = true, candles = [{ ts_ms: T, close: 100 }]) {
  let paintedX = x;
  let range = { from: 100, to: 130 };
  const scale = { timeToCoordinate: vi.fn(() => paintedX), getVisibleLogicalRange: () => range,
    width: () => 500, coordinateToLogical: () => logical, setVisibleLogicalRange: vi.fn((next: typeof range) => {
      range = next; paintedX = 50;
    }) };
  const chart = { timeScale: () => scale, setCrosshairPosition: vi.fn(), clearCrosshairPosition: vi.fn() };
  const series = { priceToCoordinate: () => 200 };
  const onNeedCandle = vi.fn();
  render(<TradeBrowseCrosshair chart={chart as unknown as IChartApi} axis={{ toVirtual: (n: number) => n } as VirtualAxis}
    candles={candles} paneSeries={new Map([['candle', series]]) as unknown as PaneSeriesMap} windowId="chart" group={1}
    code="005930" timeframe="1m" venue="KRX" onNeedCandle={onNeedCandle} enabled={enabled} />);
  act(() => { vi.runAllTimers(); });
  return { chart, scale, onNeedCandle };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  useTradeBrowseStore.setState({ session: { ownerId: 'tape', origin: { windowId: 'chart', group: 1, code: '005930',
    timeframe: '1m', venue: 'KRX' }, seed: { date: '20260929', fromMs: T, toMs: T+60000,
    timeframe: '1m', venue: 'KRX', regularSessionOnly: false }, cursorMs: T, browsing: true,
    selectedVenue: 'KRX', sourcePref: 'hogaplay', minAmountManwon: 0 } });
});
afterEach(() => { cleanup(); useTradeBrowseStore.getState().end(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('draws the actual candle close without moving an already-visible viewport', () => {
  const { chart, scale } = scene();
  expect(chart.setCrosshairPosition).toHaveBeenCalledWith(100, T / 1000, expect.anything());
  expect(scale.setVisibleLogicalRange).not.toHaveBeenCalled();
  expect(hasSyntheticCrosshair(chart as unknown as IChartApi)).toBe(true);
  expect(screen.getByTestId('trade-browse-crosshair')).toHaveAttribute('data-rendered-ms', String(T));
  act(() => useTradeBrowseStore.getState().end());
  expect(chart.clearCrosshairPosition).toHaveBeenCalledOnce();
});
it('pans only enough to reveal an offscreen candle while preserving the zoom span', () => {
  const { scale } = scene(-20, 90);
  expect(scale.setVisibleLogicalRange).toHaveBeenCalledExactlyOnceWith({ from: 87, to: 117 });
});
it('does not clear a real user crosshair that has retaken ownership', () => {
  const { chart } = scene();
  releaseSyntheticCrosshair(chart as unknown as IChartApi);
  act(() => useTradeBrowseStore.getState().end());
  expect(chart.clearCrosshairPosition).not.toHaveBeenCalled();
});
it('requests a missing candle at the chosen time without fabricating a crosshair', () => {
  const { chart, onNeedCandle } = scene(50, 110, true, [{ ts_ms: T+60000, close: 100 }]);
  expect(onNeedCandle).toHaveBeenCalledExactlyOnceWith(T);
  expect(chart.setCrosshairPosition).not.toHaveBeenCalled();
  expect(screen.getByTestId('trade-browse-crosshair')).toHaveAttribute('data-state', 'missing');
});
it('honors the consuming chart hover-link switch', () => {
  const { chart, onNeedCandle } = scene(50, 110, false);
  expect(chart.setCrosshairPosition).not.toHaveBeenCalled();
  expect(onNeedCandle).not.toHaveBeenCalled();
  expect(screen.queryByTestId('trade-browse-crosshair')).not.toBeInTheDocument();
});
