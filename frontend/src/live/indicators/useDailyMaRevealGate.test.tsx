import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLivePageStore } from '../../state/livePage';
import { useDailyMaRevealGate } from './useDailyMaRevealGate';
import { subtractDaysKst } from '../liveDateTime';

const resolvedDailyCandlesMock = vi.fn();
vi.mock('./useResolvedDailyCandles', () => ({
  useResolvedDailyCandles: (...args: unknown[]) => resolvedDailyCandlesMock(...args),
}));

const ARGS = { code: '005930', timeframe: '1m' as const, venue: 'KRX' as const, todayKst: '20260527' };

describe('useDailyMaRevealGate (개선안 1-B)', () => {
  beforeEach(() => {
    resolvedDailyCandlesMock.mockReset();
    resolvedDailyCandlesMock.mockReturnValue({ candles: [], isLoading: false, dataWarnings: [], error: null, sourceByDate: new Map() });
    // 일봉 MA 활성 = **켜진 슬롯의 존재**(마스터 토글이 슬롯으로 접혔다).
    useLivePageStore.setState({
      dailyMovingAverages: [{ id: 'ma1', enabled: true, period: 5, color: '#fff', lineWidth: 1 }],
    } as never);
  });

  // ── displayFloorDate lockstep (2026-08-24) ───────────────────────────────
  // 넷(오버레이 · 이 게이트 · 최대벽 필터 ask/bid)이 **같은 창**을 요청해야 일봉 fetch 가
  // 하나로 모인다. 이 인자를 흘려보내지 않으면 게이트만 좁은 창을 따로 받는다 —
  // 옵셔널 인자라 타입은 그 누락을 못 잡는다.
  it('displayFloorDate 를 fetch 창에 반영한다 (누락하면 게이트만 다른 쿼리키를 쓴다)', () => {
    resolvedDailyCandlesMock.mockReturnValue({ candles: [], isLoading: true, dataWarnings: [], error: null, sourceByDate: new Map() });
    renderHook(() => useDailyMaRevealGate(ARGS));
    const withoutFloor = resolvedDailyCandlesMock.mock.calls[0][0].from as string;

    resolvedDailyCandlesMock.mockClear();
    renderHook(() => useDailyMaRevealGate({ ...ARGS, displayFloorDate: subtractDaysKst(ARGS.todayKst, 700) }));
    const withFloor = resolvedDailyCandlesMock.mock.calls[0][0].from as string;

    expect(withFloor < withoutFloor).toBe(true);
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

  it('does not hold when every daily slot is disabled', () => {
    useLivePageStore.setState({
      dailyMovingAverages: [{ id: 'ma1', enabled: false, period: 5, color: '#fff', lineWidth: 1 }],
    } as never);
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
