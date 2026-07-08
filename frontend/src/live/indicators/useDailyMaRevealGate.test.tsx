import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLivePageStore } from '../../state/livePage';
import { useDailyMaRevealGate } from './useDailyMaRevealGate';

const resolvedDailyCandlesMock = vi.fn();
vi.mock('./useResolvedDailyCandles', () => ({
  useResolvedDailyCandles: (...args: unknown[]) => resolvedDailyCandlesMock(...args),
}));

const ARGS = { code: '005930', timeframe: '1m' as const, venue: 'KRX' as const, todayKst: '20260527' };

describe('useDailyMaRevealGate (개선안 1-B)', () => {
  beforeEach(() => {
    resolvedDailyCandlesMock.mockReset();
    resolvedDailyCandlesMock.mockReturnValue({ candles: [], isLoading: false, dataWarnings: [], error: null, sourceByDate: new Map() });
    // 일봉 MA 활성 + 슬롯 하나.
    useLivePageStore.setState({
      dailyMovingAverageEnabled: true,
      dailyMovingAverages: [{ id: 'ma1', period: 5, color: '#fff', lineWidth: 1 }],
    } as never);
  });

  it('reports loading while enabled + query pending with no candles yet', () => {
    resolvedDailyCandlesMock.mockReturnValue({ candles: [], isLoading: true, dataWarnings: [], error: null, sourceByDate: new Map() });
    const { result } = renderHook(() => useDailyMaRevealGate(ARGS));
    expect(result.current).toBe(true);
  });

  it('clears once the daily candles arrive (cache hit / settle with data)', () => {
    resolvedDailyCandlesMock.mockReturnValue({
      candles: [{ t_ms: 1779840000000, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      isLoading: true,
      dataWarnings: [], error: null, sourceByDate: new Map(),
    });
    const { result } = renderHook(() => useDailyMaRevealGate(ARGS));
    expect(result.current).toBe(false);
  });

  it('does not hold when daily MA is disabled (enabled=false)', () => {
    useLivePageStore.setState({ dailyMovingAverageEnabled: false } as never);
    resolvedDailyCandlesMock.mockReturnValue({ candles: [], isLoading: true, dataWarnings: [], error: null, sourceByDate: new Map() });
    const { result } = renderHook(() => useDailyMaRevealGate(ARGS));
    expect(result.current).toBe(false);
  });

  it('does not hold on calendar timeframes (daily MA is minute-only)', () => {
    resolvedDailyCandlesMock.mockReturnValue({ candles: [], isLoading: true, dataWarnings: [], error: null, sourceByDate: new Map() });
    const { result } = renderHook(() => useDailyMaRevealGate({ ...ARGS, timeframe: 'D' }));
    expect(result.current).toBe(false);
  });

  it('does not hold when code is null', () => {
    resolvedDailyCandlesMock.mockReturnValue({ candles: [], isLoading: true, dataWarnings: [], error: null, sourceByDate: new Map() });
    const { result } = renderHook(() => useDailyMaRevealGate({ ...ARGS, code: null }));
    expect(result.current).toBe(false);
  });
});
