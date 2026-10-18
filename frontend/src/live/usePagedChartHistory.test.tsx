import { act, cleanup, renderHook } from '@testing-library/react';
import type { IChartApi } from 'lightweight-charts';
import { afterEach, expect, it, vi } from 'vitest';
import { buildPriceBundle } from './buildIndexBundle';
import { createVirtualAxis } from '../util/virtualAxis';
import { usePagedChartHistory } from './usePagedChartHistory';

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
