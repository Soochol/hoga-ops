import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  useScreenerMonitor,
  MONITOR_PERIOD_SCOPED_MS,
  MONITOR_PERIOD_FULL_MS,
  MONITOR_FAIL_LIMIT,
  type UseScreenerMonitorArgs,
} from './useScreenerMonitor';
import * as liveQuotes from '../api/liveQuotes';
import * as ws from '../api/ws';
import type { PushEvent } from '../api/types';

let push: (event: PushEvent) => void;
const volumeConditions: UseScreenerMonitorArgs['conditions'] = [
  { id: 'volume', type: 'new_high_vol', params: { timeframe: '1m', lookback: 5, period: 100 } },
];

function mockPhase(phase: 'pre_open' | 'open' | 'closed' | undefined) {
  // 저수준 `useQuotes` 가 아니라 `useLiveQuoteOverlay` 를 모킹한다 — 훅이 그쪽으로
  // 바뀐 이유는 useScreenerMonitor 주석 참조(드로어와 같은 훅을 타야 queryKey 가
  // 일치해 캐시가 실제로 공유된다).
  vi.spyOn(liveQuotes, 'useLiveQuoteOverlay').mockReturnValue(
    { quoteByCode: new Map(), phase, dataUpdatedAt: 0 } as unknown as liveQuotes.LiveQuoteOverlay,
  );
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

const baseArgs = (over: Partial<UseScreenerMonitorArgs> = {}): UseScreenerMonitorArgs => ({
  active: true,
  selectedId: 's1',
  periodMs: MONITOR_PERIOD_FULL_MS,
  disabled: false,
  resultCodes: ['005930'],
  hasResults: true,
  scanOnce: vi.fn().mockResolvedValue(true),
  onAutoStop: vi.fn(),
  ...over,
});

describe('useScreenerMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockPhase('open');
    vi.spyOn(ws, 'subscribeEvents').mockImplementation(listener => {
      push = listener;
      return vi.fn();
    });
    setHidden(false);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('시작 시 즉시 1회 조회하고 주기마다 재조회한다(전체 30초)', async () => {
    const scanOnce = vi.fn().mockResolvedValue(true);
    renderHook((props: UseScreenerMonitorArgs) => useScreenerMonitor(props), {
      initialProps: baseArgs({ scanOnce }),
    });
    await act(async () => { await Promise.resolve(); });
    expect(scanOnce).toHaveBeenCalledTimes(1);            // 즉시 1회
    await act(async () => { await vi.advanceTimersByTimeAsync(MONITOR_PERIOD_FULL_MS); });
    expect(scanOnce).toHaveBeenCalledTimes(2);            // 30초 후 2회
  });

  it('전달된 주기(periodMs)대로 재조회한다 — 스코프 15초', async () => {
    const scanOnce = vi.fn().mockResolvedValue(true);
    renderHook((props: UseScreenerMonitorArgs) => useScreenerMonitor(props), {
      initialProps: baseArgs({ scanOnce, periodMs: MONITOR_PERIOD_SCOPED_MS }),
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(MONITOR_PERIOD_SCOPED_MS); });
    expect(scanOnce).toHaveBeenCalledTimes(2);
  });

  it('active=false 면 조회하지 않는다', async () => {
    const scanOnce = vi.fn().mockResolvedValue(true);
    renderHook((props: UseScreenerMonitorArgs) => useScreenerMonitor(props), {
      initialProps: baseArgs({ scanOnce, active: false }),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(MONITOR_PERIOD_FULL_MS); });
    expect(scanOnce).not.toHaveBeenCalled();
  });

  it('장마감(closed)이면 조회를 멈추고 paused=closed 를 알린다', async () => {
    mockPhase('closed');
    const scanOnce = vi.fn().mockResolvedValue(true);
    const { result } = renderHook((props: UseScreenerMonitorArgs) => useScreenerMonitor(props), {
      initialProps: baseArgs({ scanOnce }),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(MONITOR_PERIOD_FULL_MS); });
    expect(scanOnce).not.toHaveBeenCalled();
    expect(result.current.paused).toBe('closed');
  });

  it('장마감이라도 보여줄 결과가 없으면 1회 조회한다(시작 시 초기화 직후)', async () => {
    mockPhase('closed');
    const scanOnce = vi.fn().mockResolvedValue(true);
    renderHook((props: UseScreenerMonitorArgs) => useScreenerMonitor(props), {
      initialProps: baseArgs({ scanOnce, hasResults: false }),
    });
    await act(async () => { await Promise.resolve(); });
    expect(scanOnce).toHaveBeenCalledTimes(1);            // 빈 화면으로 끝내지 않는다
  });

  it('탭 숨김이라도 보여줄 결과가 없으면 조회한다', async () => {
    const scanOnce = vi.fn().mockResolvedValue(true);
    setHidden(true);
    renderHook((props: UseScreenerMonitorArgs) => useScreenerMonitor(props), {
      initialProps: baseArgs({ scanOnce, hasResults: false }),
    });
    await act(async () => { await Promise.resolve(); });
    expect(scanOnce).toHaveBeenCalledTimes(1);
  });

  it('탭 숨김이면 조회하지 않고, 복귀 시 즉시 재조회한다', async () => {
    const scanOnce = vi.fn().mockResolvedValue(true);
    setHidden(true);
    renderHook((props: UseScreenerMonitorArgs) => useScreenerMonitor(props), {
      initialProps: baseArgs({ scanOnce }),
    });
    await act(async () => { await Promise.resolve(); });
    expect(scanOnce).not.toHaveBeenCalled();              // 숨김 상태 즉시 조회 안 함
    await act(async () => { setHidden(false); await Promise.resolve(); });
    expect(scanOnce).toHaveBeenCalledTimes(1);            // 복귀 즉시 조회
  });

  it('연속 실패가 임계에 이르면 onAutoStop 을 호출하고 루프를 멈춘다', async () => {
    const scanOnce = vi.fn().mockResolvedValue(false);
    const onAutoStop = vi.fn();
    renderHook((props: UseScreenerMonitorArgs) => useScreenerMonitor(props), {
      initialProps: baseArgs({ scanOnce, onAutoStop }),
    });
    // 즉시 1회 실패 후 지수 백오프(2·4·8·16 × 30초)로 임계까지.
    await act(async () => { await Promise.resolve(); });
    for (let i = 1; i < MONITOR_FAIL_LIMIT; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(MONITOR_PERIOD_FULL_MS * 2 ** i); });
    }
    expect(scanOnce).toHaveBeenCalledTimes(MONITOR_FAIL_LIMIT);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
  });

  it('선택 저장본이 바뀌면 즉시 재조회한다(재앵커)', async () => {
    const scanOnce = vi.fn().mockResolvedValue(true);
    const { rerender } = renderHook((props: UseScreenerMonitorArgs) => useScreenerMonitor(props), {
      initialProps: baseArgs({ scanOnce }),
    });
    await act(async () => { await Promise.resolve(); });
    expect(scanOnce).toHaveBeenCalledTimes(1);
    await act(async () => { rerender(baseArgs({ scanOnce, selectedId: 's2' })); await Promise.resolve(); });
    expect(scanOnce).toHaveBeenCalledTimes(2);            // 재앵커 즉시 조회
  });

  it('거래량 도달 푸시는 30초를 기다리지 않고 모아서 조회한다', async () => {
    const scanOnce = vi.fn().mockResolvedValue(true);
    renderHook(() => useScreenerMonitor(baseArgs({ scanOnce, conditions: volumeConditions })));
    await act(async () => { await Promise.resolve(); });
    act(() => {
      push({ type: 'screener_volume_changed', condition_ids: ['other'] });
      push({ type: 'screener_volume_changed', condition_ids: ['volume'] });
      push({ type: 'screener_volume_changed', condition_ids: ['volume'] });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(scanOnce).toHaveBeenCalledTimes(2);
  });

  it('장마감 위상 전환 직후의 종가 체결 도달 신호는 최종 조회한다', async () => {
    mockPhase('closed');
    const scanOnce = vi.fn().mockResolvedValue(true);
    renderHook(() => useScreenerMonitor(baseArgs({ scanOnce, conditions: volumeConditions })));
    expect(scanOnce).not.toHaveBeenCalled();
    act(() => { push({ type: 'screener_volume_changed', condition_ids: ['volume'] }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(scanOnce).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(scanOnce).toHaveBeenCalledTimes(1);
  });

  it('조회 도중 푸시와 탭 복귀가 겹쳐도 동시 요청 없이 후속 조회 하나만 수행한다', async () => {
    let finish!: (value: boolean) => void;
    const scanOnce = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }))
      .mockResolvedValue(true);
    const { unmount } = renderHook(() => useScreenerMonitor(baseArgs({ scanOnce, conditions: volumeConditions })));
    act(() => {
      push({ type: 'screener_volume_changed', condition_ids: ['volume'] });
      setHidden(false);
      push({ type: 'screener_volume_changed', condition_ids: ['volume'] });
    });
    expect(scanOnce).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(scanOnce).toHaveBeenCalledTimes(2);
    unmount();
    act(() => { push({ type: 'screener_volume_changed', condition_ids: ['volume'] }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(scanOnce).toHaveBeenCalledTimes(2);
  });
});
