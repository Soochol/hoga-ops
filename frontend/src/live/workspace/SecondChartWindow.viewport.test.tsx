import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { WorkspaceWindow } from '../../state/workspace';
import { SecondChartWindow } from './SecondChartWindow';

const fixture = vi.hoisted(() => {
  const bars = Array.from({ length: 300 }, (_, i) => ({ t_ms: 1_790_816_400_000 + i * 30_000,
    open: 100, high: 110, low: 90, close: 105, volume: 10, count: 1, trade_value: 1000 }));
  return { bars, query: { bars, hasNextPage: false, isFetchingNextPage: false, catalogPending: false,
    isPending: false, isError: false, fetchNextPage: vi.fn() },
    range: { from: 0, to: 239 }, spacing: 6,
    setRange: vi.fn(), setData: vi.fn(), applyOptions: vi.fn() };
});

vi.mock('../../api/secondHistory', () => ({ SECOND_INITIAL_BARS: 240, useSecondHistory: () => fixture.query }));
vi.mock('../useEffectiveVenue', () => ({ useEffectiveVenue: () => 'KRX' }));
vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'candles', HistogramSeries: 'volume', LineSeries: 'ma',
  createChart: () => ({
    addSeries: () => ({ setData: fixture.setData, options: () => ({ upColor: 'red', downColor: 'blue' }) }),
    panes: () => [{ setStretchFactor: vi.fn() }, { setStretchFactor: vi.fn() }],
    timeScale: () => ({
      options: () => ({ barSpacing: fixture.spacing }),
      getVisibleLogicalRange: () => fixture.range,
      setVisibleLogicalRange: (range: { from: number; to: number }) => {
        fixture.setRange(range);
        fixture.range = range;
        fixture.spacing = 480 / (range.to - range.from + 1);
      },
      applyOptions: (options: { barSpacing: number }) => {
        fixture.applyOptions(options);
        fixture.spacing = options.barSpacing;
      },
      subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn(),
    }),
    subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(), resize: vi.fn(), remove: vi.fn(),
  }),
}));

it('retains user zoom and time anchor across an empty loading page and a session-filter round trip', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const win: WorkspaceWindow = { id: 'zoom-chart', kind: 'chart', group: 1,
    rect: { x: 0, y: 0, w: 0.5, h: 0.5 } };
  const symbol = { code: '005930', name: '삼성전자', kind: 'stock' as const };
  const view = render(<SecondChartWindow win={win} symbol={symbol} timeframe="30s" />);
  // The user has zoomed and scrolled away from the initial 240-candle view.
  fixture.range = { from: 90.25, to: 105.25 };
  fixture.spacing = 18;
  fixture.setData.mockClear();
  fixture.setRange.mockClear();
  fixture.query = { ...fixture.query, bars: [], isPending: true };
  const regularWin: WorkspaceWindow = { ...win, chart: { timeframe: '30s', regularSessionOnly: true } };
  view.rerender(<SecondChartWindow win={regularWin} symbol={symbol} timeframe="30s" />);
  expect(fixture.setData).not.toHaveBeenCalled();
  fixture.query = { ...fixture.query, bars: fixture.bars.slice(30, 270), isPending: false };
  view.rerender(<SecondChartWindow win={regularWin} symbol={symbol} timeframe="30s" />);
  expect(fixture.range).toEqual({ from: 60.25, to: 75.25 });
  expect(fixture.spacing).toBe(18);
  fixture.query = { ...fixture.query, bars: fixture.bars };
  view.rerender(<SecondChartWindow win={win} symbol={symbol} timeframe="30s" />);
  expect(fixture.range).toEqual({ from: 90.25, to: 105.25 });
  expect(fixture.spacing).toBe(18);
  view.unmount();
  vi.unstubAllGlobals();
});
