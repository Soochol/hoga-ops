import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

// Diagnostic harness: actual workspace writes and subscriptions; warm-cache response.
describe('diagnostic: synchronous cached backfill', () => {
  it('deep warm-cache fill must not exceed React update depth', async () => {
    const mode = process.env.DIAG_MODE ?? 'sync';
    const originalExtend = useWorkspaceStore.getState().extendChartHistoricalRange;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (mode === 'deferred') useWorkspaceStore.setState({
      extendChartHistoricalRange: (id, date) => { timers.push(setTimeout(() => originalExtend(id, date), 0)); },
    });
    const id = 'diagnostic-chart';
    useWorkspaceStore.setState({
      windows: [{ id, kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 400, h: 300 }, chart: { timeframe: '1m' } }],
      zOrder: [id], groupSymbols: { 1: { code: '005930', name: '삼성전자' } }, chartRuntime: {},
    });
    const cap = chartWithCapturedHandler({ from: 0, to: 100 });
    const axis = axisWithOneSession();
    const bundle = bundleWithCandles();
    const gate = () => true;
    const dates: string[] = [];
    const unsubscribe = useWorkspaceStore.subscribe((s) => {
      const date = s.chartRuntime[id]?.historicalFromDate;
      if (date) dates.push(date);
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WindowViewContext.Provider value={{ windowId: id, group: 1, code: '005930', timeframe: '1m', historicalFromDate: null }}>
        {children}
      </WindowViewContext.Provider>
    );
    try {
      expect(() => renderHook(() => {
        const from = useWorkspaceStore(s => s.chartRuntime[id]?.historicalFromDate ?? null);
        return useViewportBackfill({ chart: cap.chart, axis, bundle, timeframe: '1m', code: '005930',
          isExtending: false, canTriggerBackfill: gate, savedRangeFromDate: mode === 'shallow' ? '20260601' : '20200101',
          settledFromDate: mode === 'no-echo' ? null : from, rangeWindowFromDate: from ?? '20260709' });
      }, { wrapper })).not.toThrow();
      if (mode === 'no-echo') expect(dates).toHaveLength(1);
      if (mode !== 'no-echo') await waitFor(() => {
        expect(dates).toHaveLength(mode === 'shallow' ? 6 : 60);
        expect(vi.mocked(livePerfLog).mock.calls.some(([event]) => event === 'viewport_backfill_stop')).toBe(true);
      }, { timeout: 5000 });
    } finally {
      unsubscribe();
      timers.forEach(clearTimeout);
      useWorkspaceStore.setState({ extendChartHistoricalRange: originalExtend });
      process.stdout.write(JSON.stringify({ mode, writes: dates.length, first: dates[0], last: dates.at(-1) }) + '\n');
    }
  });
});
