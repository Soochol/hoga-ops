import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { useViewportBackfill } from './useViewportBackfill';
import { useWorkspaceStore } from '../state/workspace';
import {
  WindowViewContext,
} from './workspace/windowView';
import { createVirtualAxis } from '../util/virtualAxis';
import { livePerfLog } from '../util/perfDebug';
import type { RangeBundle } from '../api/types';

// 반려 사유를 값으로 읽기 위해 계측을 가로챈다. 실제 구현은 debug 플래그가 꺼져 있으면
// no-op 이라 **아무것도 관측되지 않는다** — 테스트에서 사유를 재려면 모킹이 유일한 길이다.
vi.mock('../util/perfDebug', () => ({
  livePerfLog: vi.fn(),
  livePerfDebugEnabled: () => false,
}));

// 09:00–15:30 KST 세션 한 개짜리 축 — segments.length>0 이라 3a/3b 가 조기 반환하지
// 않는다. sessionOpenMs 는 nextHistoricalFrom 의 axisEarliestMs 인자로만 쓰인다.
const KST = 9 * 60 * 60 * 1000;
function axisWithOneSession() {
  const open = Date.UTC(2026, 6, 9, 0, 0) - KST + 9 * 3600_000; // 2026-07-09 09:00 KST
  const close = open + 6.5 * 3600_000;
  return createVirtualAxis([{ date: '20260709', sessionOpenMs: open, sessionCloseMs: close }]);
}

// candleCountRef>0 이 되도록 캔들 1개만 있으면 충분(3a/3b 의 빈 차트 가드 통과).
function bundleWithCandles(code = '005930'): RangeBundle {
  return {
    code,
    from_date: '20260709',
    to_date: '20260709',
    bucket_ms: 60_000,
    segments: [{ date: '20260709', session_open_ms: 0, session_close_ms: 1, source: 'kiwoom_live' }],
    candles: [{ ts_ms: 1_000, open: 1, high: 1, low: 1, close: 1, vol_a: 1, vol_b: 0 }],
    quote_ratio: { bucket_ms: 60_000, points: [] },
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    broker_late_entries: [],
  };
}

/** 3b lazy-fetch 핸들러를 캡처하는 timeScale mock. 모든 effect(1 스냅샷, 2 재배치,
 * 3a settle-loop, 3b trigger)가 호출하는 API를 no-op 으로 채운다. */
function chartWithCapturedHandler(logicalRange: { from: number; to: number } = { from: -5, to: 100 }) {
  let logicalHandler: ((range: unknown) => void) | null = null;
  const ts = {
    getVisibleLogicalRange: vi.fn(() => logicalRange),
    getVisibleRange: vi.fn(() => ({ from: 1, to: 2 })),
    timeToIndex: vi.fn(() => 0),
    setVisibleLogicalRange: vi.fn(),
    subscribeVisibleLogicalRangeChange: vi.fn((h: (range: unknown) => void) => {
      logicalHandler = h;
    }),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  };
  const chart = { timeScale: () => ts } as never;
  return { chart, ts, fire: (range: unknown) => logicalHandler?.(range) };
}

// Keep the real workspace action and subscription: a no-op extend spy cannot
// reproduce the React -> store -> cached response -> React feedback chain.
const WINDOW_ID = 'cached-backfill';
const stableAxis = axisWithOneSession();
const stableBundle = bundleWithCandles();
const allowBackfill = () => true;
type HookArgs = Parameters<typeof useViewportBackfill>[0];

function mountCached(overrides: Partial<HookArgs> = {}) {
  const cap = chartWithCapturedHandler({ from: 0, to: 100 });
  const dates: string[] = [];
  const unsubscribe = useWorkspaceStore.subscribe((state, prev) => {
    const date = state.chartRuntime[WINDOW_ID]?.historicalFromDate;
    if (date && date !== prev.chartRuntime[WINDOW_ID]?.historicalFromDate) dates.push(date);
  });
  subscriptions.push(unsubscribe);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WindowViewContext.Provider value={{ windowId: WINDOW_ID, group: 1, code: '005930', timeframe: '1m', historicalFromDate: null }}>
      {children}
    </WindowViewContext.Provider>
  );
  const hook = renderHook((props: Partial<HookArgs>) => {
    const from = useWorkspaceStore(s => s.chartRuntime[WINDOW_ID]?.historicalFromDate ?? null);
    return useViewportBackfill({
      chart: cap.chart, axis: stableAxis, bundle: stableBundle, timeframe: '1m', code: '005930',
      isExtending: false, canTriggerBackfill: allowBackfill, savedRangeFromDate: '20260601',
      candleSourceKey: 'disk', settledFromDate: from, rangeWindowFromDate: from ?? '20260709',
      ...props,
    });
  }, { wrapper, initialProps: overrides });
  return { ...hook, dates, cap };
}

let subscriptions: (() => void)[] = [];
beforeEach(() => {
  vi.mocked(livePerfLog).mockClear();
  useWorkspaceStore.setState({
    windows: [{ id: WINDOW_ID, kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 400, h: 300 }, chart: { timeframe: '1m' } }],
    zOrder: [WINDOW_ID], groupSymbols: { 1: { code: '005930', name: '삼성전자' } }, chartRuntime: {},
  });
});
afterEach(() => {
  cleanup();
  subscriptions.forEach(unsubscribe => unsubscribe());
  subscriptions = [];
  vi.useRealTimers();
});

describe('useViewportBackfill — real workspace with consecutive cache hits', () => {
  it('finishes the 60-step budget without exceeding React update depth', async () => {
    const { dates } = mountCached({ savedRangeFromDate: '20200101' });
    await waitFor(() => expect(dates).toHaveLength(60));
    expect(new Set(dates).size).toBe(60);
    expect(dates.at(-1)).toBe('20250515');
    expect(vi.mocked(livePerfLog).mock.calls).toContainEqual([
      'viewport_backfill_stop', expect.objectContaining({ stepCount: 60, budget: 60 }),
    ]);
  });

  it('re-arms after dependency churn without spending the budget twice', () => {
    vi.useFakeTimers();
    const { dates, rerender } = mountCached();
    expect(dates).toHaveLength(1);
    rerender({ axis: axisWithOneSession() });
    rerender({ axis: axisWithOneSession() });
    act(() => vi.advanceTimersToNextTimer());
    expect(dates).toHaveLength(2);
    for (let i = 0; i < 5; i++) act(() => vi.advanceTimersToNextTimer());
    expect(dates).toHaveLength(6);
    expect(dates.at(-1)).toBe('20260528');
  });

  it('cancels pending progress on unmount', () => {
    vi.useFakeTimers();
    const { dates, unmount } = mountCached();
    expect(dates).toHaveLength(1);
    unmount();
    act(() => vi.runOnlyPendingTimers());
    expect(dates).toHaveLength(1);
  });

  it('cancels pending progress when the chart is replaced', () => {
    vi.useFakeTimers();
    const { dates, rerender } = mountCached();
    expect(dates).toHaveLength(1);
    rerender({ chart: chartWithCapturedHandler().chart });
    act(() => vi.runOnlyPendingTimers());
    expect(dates).toHaveLength(1);
  });

  it('cancels the old source continuation and waits for the new source to settle', () => {
    vi.useFakeTimers();
    const { dates, rerender } = mountCached();
    expect(dates).toHaveLength(1);
    rerender({ candleSourceKey: 'vendor', isExtending: true, settledFromDate: null });
    act(() => vi.runOnlyPendingTimers());
    expect(dates).toHaveLength(1);
    rerender({ candleSourceKey: 'vendor' });
    expect(dates).toHaveLength(2); // the new source's completion resumes the target
  });

  it.each([
    { code: '000660' },
    { timeframe: '5m' as const },
  ])('cancels pending progress when view identity changes: %j', (change) => {
    vi.useFakeTimers();
    const { dates, rerender } = mountCached();
    expect(dates).toHaveLength(1);
    rerender({ ...change, savedRangeFromDate: null });
    act(() => vi.runOnlyPendingTimers());
    expect(dates).toHaveLength(1);
  });

  it('rechecks a newly learned floor before advancing', () => {
    vi.useFakeTimers();
    const { dates, rerender } = mountCached();
    expect(dates).toEqual(['20260702']);
    rerender({ minuteScrollbackFloorDate: '20260702' });
    act(() => vi.runOnlyPendingTimers());
    expect(dates).toEqual(['20260702']);
    expect(vi.mocked(livePerfLog).mock.calls).toContainEqual([
      'viewport_backfill_stop', expect.objectContaining({ historicalFromDate: '20260702' }),
    ]);
  });

  it('replaces a pending step with the new saved-range fill', () => {
    vi.useFakeTimers();
    const { dates, rerender } = mountCached();
    expect(dates).toHaveLength(1);
    rerender({ savedRangeFromDate: '20260501' });
    // The explicit new target starts its own first step immediately.
    expect(dates).toHaveLength(2);
    for (let i = 0; i < 12; i++) act(() => vi.advanceTimersToNextTimer());
    expect(dates).toHaveLength(10);
    expect(dates.at(-1)).toBe('20260430');
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('rejects stale echoes and cancels a cached continuation when a fetch starts', () => {
    vi.useFakeTimers();
    const { dates, rerender } = mountCached({ settledFromDate: '20990101' });
    act(() => vi.runOnlyPendingTimers());
    expect(dates).toHaveLength(1);
    rerender({}); // valid echo schedules the cached continuation
    rerender({ isExtending: true });
    act(() => vi.runOnlyPendingTimers());
    expect(dates).toHaveLength(1);
    rerender({}); // fetch falling edge consumes exactly one step
    expect(dates).toHaveLength(2);
    act(() => vi.advanceTimersToNextTimer());
    expect(dates).toHaveLength(3);
  });

  it('rechecks the gate at dispatch without consuming a cancelled step', () => {
    vi.useFakeTimers();
    let allowed = true;
    const canTriggerBackfill = () => allowed;
    const { dates, rerender } = mountCached({ canTriggerBackfill });
    allowed = false;
    act(() => vi.runOnlyPendingTimers());
    expect(dates).toHaveLength(1);
    allowed = true;
    rerender({ canTriggerBackfill, axis: axisWithOneSession() });
    for (let i = 0; i < 6; i++) act(() => vi.advanceTimersToNextTimer());
    expect(dates).toHaveLength(6);
  });
});
