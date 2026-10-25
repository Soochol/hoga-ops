import { act, cleanup, renderHook } from '@testing-library/react';
import { useEffect } from 'react';
import type { IChartApi } from 'lightweight-charts';
import { afterEach, expect, it, vi } from 'vitest';
import { buildPriceBundle } from './buildIndexBundle';
import { createVirtualAxis } from '../util/virtualAxis';
import { usePagedChartHistory } from './usePagedChartHistory';
import { realMsToVirtualSeconds } from './viewportAnchor';

const origin = Date.UTC(2026, 9, 16, 12);
const bundle = (generation: number) => buildPriceBundle({ code: 'us-stock:NASDAQ:NVDA', from: '20261016', to: '20261016', bucketMs: 60_000, observedSessions: true,
  candles: [{ trading_date: '20261016', t_ms: origin - generation * 60_000, open: 10, high: 11, low: 9, close: 10, volume: 1 }] });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('limits automatic page commits to three until another wheel/pointer gesture', async () => {
  vi.useFakeTimers();
  const loadOlder = vi.fn();
  const ts = { getVisibleLogicalRange: () => ({ from: -5000, to: -4700 }), timeToIndex: () => 0,
    setVisibleLogicalRange: vi.fn(), scrollToPosition: vi.fn(), subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn() };
  const chart = { timeScale: () => ts } as unknown as IChartApi;
  const axis = createVirtualAxis([{ date: '20261016', sessionOpenMs: origin - 10_000_000, sessionCloseMs: origin + 60_000 }]);
  const element = document.createElement('div'), ref = { current: element };
  const { rerender, unmount } = renderHook(({ generation }) => usePagedChartHistory(chart, axis, bundle(generation),
    { hasMore: true, loading: false, blocked: false, loadOlder }, ref), { initialProps: { generation: 0 } });
  for (let i = 1; i <= 4; i++) {
    await act(async () => vi.advanceTimersByTimeAsync(200));
    rerender({ generation: i });
  }
  expect(loadOlder).toHaveBeenCalledTimes(3);
  act(() => element.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 })));
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(loadOlder).toHaveBeenCalledTimes(4);
  act(() => element.dispatchEvent(new MouseEvent('pointerdown')));
  unmount();
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(loadOlder).toHaveBeenCalledTimes(4);
});

it.each([{ hasMore: false, loading: false, blocked: false }, { hasMore: true, loading: true, blocked: false },
  { hasMore: true, loading: false, blocked: true }])('does not schedule a request when blocked by %o', async flags => {
  vi.useFakeTimers();
  const loadOlder = vi.fn();
  const chart = { timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 0, to: 300 }),
    subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn() }) } as unknown as IChartApi;
  renderHook(() => usePagedChartHistory(chart, createVirtualAxis([]), bundle(0), { ...flags, loadOlder }, { current: document.createElement('div') }));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(loadOlder).not.toHaveBeenCalled();
});

it('gesture-only one-page policy stops after one page even while the viewport is still empty', async () => {
  vi.useFakeTimers();
  const loadOlder = vi.fn();
  const ts = { getVisibleLogicalRange: () => ({ from: -5000, to: -4700 }), timeToIndex: () => 0,
    setVisibleLogicalRange: vi.fn(), scrollToPosition: vi.fn(), subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn() };
  const chart = { timeScale: () => ts } as unknown as IChartApi;
  const element = document.createElement('div');
  const control = { hasMore: true, loading: false, blocked: false, pagesPerGesture: 1, loadOlder };
  const view = renderHook(({ generation }) => usePagedChartHistory(chart, createVirtualAxis([]), bundle(generation), control, { current: element }),
    { initialProps: { generation: 0 } });
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(loadOlder).not.toHaveBeenCalled();
  act(() => element.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 })));
  for (let generation = 1; generation <= 4; generation++) {
    await act(async () => vi.advanceTimersByTimeAsync(200));
    view.rerender({ generation });
  }
  expect(loadOlder).toHaveBeenCalledTimes(1);
  act(() => element.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 })));
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(loadOlder).toHaveBeenCalledTimes(2);
});

function fillingChart() {
  vi.useFakeTimers();
  const axis = createVirtualAxis([{ date: '20261016', sessionOpenMs: origin - 3600_000, sessionCloseMs: origin + 3600_000 }]);
  const history = (prepend: number) => buildPriceBundle({ code: '005930', from: '20261016', to: '20261016', bucketMs: 1000, observedSessions: true,
    candles: Array.from({ length: 240 + prepend }, (_, i) => ({ trading_date: '20261016', t_ms: origin + (i - prepend) * 1000,
      open: 10, high: 11, low: 9, close: 10, volume: 1 })) });
  let installed = history(0);
  let range = { from: -500.25, to: 239.5 };
  const listeners = new Set<() => void>();
  const move = (next: typeof range) => { range = next; listeners.forEach(fn => fn()); };
  const ts = { getVisibleLogicalRange: () => range,
    timeToIndex: (time: number) => {
      const i = installed.candles.findIndex(c => realMsToVirtualSeconds(axis, c.ts_ms) === time);
      return i < 0 ? null : i;
    },
    setVisibleLogicalRange: vi.fn(move), scrollToPosition: vi.fn(),
    subscribeVisibleLogicalRangeChange: (fn: () => void) => listeners.add(fn),
    unsubscribeVisibleLogicalRangeChange: (fn: () => void) => listeners.delete(fn) };
  const chart = { timeScale: () => ts } as unknown as IChartApi;
  const element = document.createElement('div'), ref = { current: element };
  let settle: () => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const loadOlder = vi.fn(() => new Promise<void>((resolve, fail) => { settle = resolve; reject = fail; }));
  const defaults = { prepend: 0, loading: false, blocked: false, hasMore: true, chart };
  const view = renderHook((props: typeof defaults) => {
    const data = history(props.prepend);
    // Mirrors LiveChartRoot: capture in layout, install series, then restore.
    useEffect(() => { installed = data; }, [data]);
    usePagedChartHistory(props.chart, axis, data, { ...props, fillViewport: true, loadOlder }, ref);
  }, { initialProps: defaults });
  return { loadOlder, ts, move, range: () => range, input: () => act(() => element.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }))),
    commit: (props: Partial<typeof defaults>) => view.rerender({ ...defaults, ...props }),
    settle: () => act(async () => { settle(); }), reject: () => act(async () => { reject(new Error('offline')); }),
    tick: () => act(async () => vi.advanceTimersByTimeAsync(200)), unmount: view.unmount };
}

it('fills a frozen viewport deficit with sequential pages after one gesture', async () => {
  const h = fillingChart();
  await h.tick();
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.input();
  for (let page = 1; page <= 3; page++) {
    await h.tick();
    expect(h.loadOlder).toHaveBeenCalledTimes(page);
    h.commit({ prepend: (page - 1) * 240, loading: true });
    await h.tick();
    expect(h.loadOlder).toHaveBeenCalledTimes(page);
    h.commit({ prepend: page * 240 });
    await h.settle();
  }
  await h.tick();
  expect(h.loadOlder).toHaveBeenCalledTimes(3);
  expect(h.range()).toEqual({ from: 219.75, to: 959.5 });
  // Incidental chart/poll events do not arm another fill.
  act(() => h.move({ from: -1000, to: -500 }));
  await h.tick();
  expect(h.loadOlder).toHaveBeenCalledTimes(3);
  h.input();
  await h.tick();
  expect(h.loadOlder).toHaveBeenCalledTimes(4);
});

it('preserves a pan/zoom made during HTTP without extending the original fill goal', async () => {
  const h = fillingChart();
  h.input();
  await h.tick();
  act(() => h.move({ from: -900.25, to: -600.5 }));
  for (let page = 1; page <= 3; page++) {
    h.commit({ prepend: page * 240 });
    expect(h.range()).toEqual({ from: -900.25 + page * 240, to: -600.5 + page * 240 });
    await h.settle();
    await h.tick();
  }
  expect(h.loadOlder).toHaveBeenCalledTimes(3);
  expect(h.range().from).toBeLessThan(0);
});

it('continues through empty and sparse pages until the source is exhausted', async () => {
  const h = fillingChart();
  h.input();
  await h.tick();
  for (const prepend of [0, 3, 3, 10]) {
    h.commit({ prepend });
    await h.settle();
    await h.tick();
  }
  expect(h.loadOlder).toHaveBeenCalledTimes(5);
  h.commit({ prepend: 10, hasMore: false });
  await h.settle();
  h.input();
  await h.tick();
  expect(h.loadOlder).toHaveBeenCalledTimes(5);
});

it('does not duplicate a pending request before loading props catch up', async () => {
  const h = fillingChart();
  h.input();
  await h.tick();
  h.commit({ prepend: 0, loading: false });
  h.input();
  await h.tick();
  expect(h.loadOlder).toHaveBeenCalledTimes(1);
  await h.settle();
  await h.tick();
  expect(h.loadOlder).toHaveBeenCalledTimes(2);
});

it.each(['error', 'floor', 'rejection', 'chart', 'unmount'] as const)('stops an active fill on %s', async reason => {
  const h = fillingChart();
  h.input();
  await h.tick();
  if (reason === 'error') h.commit({ blocked: true });
  if (reason === 'floor') h.commit({ hasMore: false });
  if (reason === 'chart') h.commit({ chart: { timeScale: () => h.ts } as unknown as IChartApi });
  if (reason === 'unmount') h.unmount();
  if (reason === 'rejection') await h.reject();
  else await h.settle();
  await h.tick();
  expect(h.loadOlder).toHaveBeenCalledTimes(1);
});
