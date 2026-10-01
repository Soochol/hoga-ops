import { render, act, fireEvent } from '@testing-library/react';
import { expect, it, vi, beforeEach } from 'vitest';
import type { WorkspaceWindow } from '../../state/workspace';
import { SecondChartWindow } from './SecondChartWindow';
import { useLiveCursorStore } from '../useLiveCursorStore';

const fixture = vi.hoisted(() => {
  const bars = Array.from({ length: 300 }, (_, i) => ({ t_ms: 1_790_816_400_000 + i * 30_000,
    open: 100, high: 110, low: 90, close: 105, volume: 10, count: 1, trade_value: 1000 }));
  return { bars, query: { bars, hasNextPage: false, isFetchingNextPage: false, catalogPending: false,
    isPending: false, isError: false, fetchNextPage: vi.fn() },
    range: { from: 0, to: 239 }, spacing: 6,
    setRange: vi.fn(), setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(),
    onRange: null as ((range: { from: number; to: number }) => void) | null,
    onCursor: null as ((event: { time?: number }) => void) | null };
});

vi.mock('../../api/secondHistory', () => ({ SECOND_INITIAL_BARS: 240, useSecondHistory: () => fixture.query }));
vi.mock('../useEffectiveVenue', () => ({ useEffectiveVenue: () => 'KRX' }));
vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'candles', HistogramSeries: 'volume', LineSeries: 'ma',
  createChart: () => ({
    addSeries: () => ({ setData: fixture.setData, update: fixture.update, options: () => ({ upColor: 'red', downColor: 'blue' }) }),
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
      subscribeVisibleLogicalRangeChange: (cb: typeof fixture.onRange) => { fixture.onRange = cb; }, unsubscribeVisibleLogicalRangeChange: (cb: typeof fixture.onRange) => { fixture.onRange = cb; },
    }),
    subscribeCrosshairMove: (handler: (event: { time?: number }) => void) => { fixture.onCursor = handler; },
    unsubscribeCrosshairMove: vi.fn(), resize: vi.fn(), remove: vi.fn(),
  }),
}));

beforeEach(() => {
  fixture.query = { ...fixture.query, bars: fixture.bars, hasNextPage: false, isFetchingNextPage: false, catalogPending: false, isPending: false };
  vi.clearAllMocks();
});

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

it('throttles linked seconds detail updates and cancels them on leave, unlink and unmount', () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useLiveCursorStore.getState().resetCursor();
  const win: WorkspaceWindow = { id: 'cursor-chart', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: .5, h: .5 } };
  const symbol = { code: '005930', name: '삼성전자', kind: 'stock' as const };
  const view = render(<SecondChartWindow win={win} symbol={symbol} timeframe="30s" />);
  const first = fixture.bars[0].t_ms / 1000;
  const move = (time?: number) => act(() => { fixture.onCursor?.({ time }); });
  const current = () => useLiveCursorStore.getState().sidebarCursorMs;
  try {
    move(first); expect(current()).toBe(first * 1000);
    move(first + 30); move(first + 60);
    expect(current()).toBe(first * 1000);
    act(() => { vi.advanceTimersByTime(120); });
    expect(current()).toBe((first + 60) * 1000);
    move(first + 90); move();
    act(() => { vi.advanceTimersByTime(120); });
    expect(current()).toBeNull();
    move(first); move(first + 30);
    view.rerender(<SecondChartWindow win={{ ...win, chart: { timeframe: '30s', hoverLinked: false } }} symbol={symbol} timeframe="30s" />);
    act(() => { vi.advanceTimersByTime(120); });
    expect(current()).toBeNull();
    view.rerender(<SecondChartWindow win={win} symbol={symbol} timeframe="30s" />);
    move(first); move(first + 30);
    useLiveCursorStore.getState().setSidebarCursor(123, { windowId: 'other', group: 2, code: '000660', timeframe: '1m' });
    view.unmount();
    act(() => { vi.advanceTimersByTime(120); });
    expect(current()).toBe(123);
  } finally { view.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); useLiveCursorStore.getState().resetCursor(); }
});
it('does not rewrite unchanged bars when pagination metadata changes', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  fixture.query = { ...fixture.query, bars: fixture.bars, hasNextPage: false, isPending: false, catalogPending: false };
  const win: WorkspaceWindow = { id: 'refresh-test', kind: 'chart', group: 1, rect: {x: 0,y: 0,w: .5,h: .5} };
  const symbol = {code: '005930',name: '삼성전자',kind: 'stock' as const};
  const view = render(<SecondChartWindow win={win} symbol={symbol} timeframe="30s" />);
  fixture.setData.mockClear();
  fixture.query = {...fixture.query, hasNextPage: true};
  view.rerender(<SecondChartWindow win={win} symbol={symbol} timeframe="30s" />);
  expect(fixture.setData).not.toHaveBeenCalled();
  view.unmount(); vi.unstubAllGlobals();
});
it('expires wheel gestures before later programmatic range changes', () => {
  vi.useFakeTimers({toFake: ['performance']});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  fixture.query = { ...fixture.query, bars: fixture.bars, hasNextPage: true, isPending: false, catalogPending: false };
  const win: WorkspaceWindow = {id: 'gesture-test',kind: 'chart',group: 1,rect: {x: 0,y: 0,w: .5,h: .5}};
  const view = render(<SecondChartWindow win={win} symbol={{code: '005930',name: '삼성전자',kind: 'stock'}} timeframe="30s" />);
  fixture.query.fetchNextPage.mockClear();
  const chartContainer = view.container.querySelector('.absolute.inset-0.font-data')!;
  fireEvent.wheel(chartContainer, {deltaY: -10});
  act(() => fixture.onRange?.({from: 40,to: 200}));
  expect(fixture.query.fetchNextPage).not.toHaveBeenCalled();
  vi.advanceTimersByTime(201);
  // No pointer/wheel event now: represent a later resize or programmatic range change.
  act(() => fixture.onRange?.({from: 5,to: 200}));
  expect(fixture.query.fetchNextPage).not.toHaveBeenCalled();
  fireEvent.wheel(chartContainer, {deltaY: -10});
  act(() => fixture.onRange?.({from: 5,to: 200}));
  expect(fixture.query.fetchNextPage).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
  view.unmount(); vi.unstubAllGlobals();
});

it('updates only changed second candle, volume and MA with 10000 loaded bars', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const bars = Array.from({length: 10000}, (_, i) => ({...fixture.bars[0],t_ms: fixture.bars[0].t_ms+i*1000}));
  fixture.query = { ...fixture.query, bars, hasNextPage: false, isPending: false, catalogPending: false };
  const win: WorkspaceWindow = {id: 'tick-test',kind: 'chart',group: 1,rect: {x: 0,y: 0,w: .5,h: .5}};
  const symbol = {code: '005930',name: '삼성전자',kind: 'stock' as const};
  const view = render(<SecondChartWindow win={win} symbol={symbol} timeframe="1s" />);
  fixture.setData.mockClear();
  fixture.query = {...fixture.query, bars: [...bars.slice(0,-1), {...bars.at(-1)!,close: 106}]};
  view.rerender(<SecondChartWindow win={win} symbol={symbol} timeframe="1s" />);
  expect(fixture.setData).not.toHaveBeenCalled();
  expect(fixture.update).toHaveBeenCalledTimes(3);
  view.unmount(); vi.unstubAllGlobals();
});
