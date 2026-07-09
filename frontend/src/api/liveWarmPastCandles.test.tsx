import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWarmPastCandles } from './liveWarmPastCandles';
import { apiAction } from './client';

vi.mock('./client', () => ({ apiAction: vi.fn().mockResolvedValue(undefined) }));

// tsconfig.app.json은 @types/node를 제외한다 — 이 테스트만 쓰는
// process 이벤트 API를 파일-스코프 앰비언트로 선언(런타임은 vitest 제공).
declare const process: {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
};

describe('useWarmPastCandles', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('디바운스 후 워밍 요청을 1회 쏜다', () => {
    renderHook(() => useWarmPastCandles('005930', 'KRX'));
    expect(apiAction).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(apiAction).toHaveBeenCalledTimes(1);
    expect(apiAction).toHaveBeenCalledWith(
      '/api/live/warm-past-candles?code=005930&venue=KRX',
      { method: 'POST' },
    );
  });

  it('code가 null이면 아무것도 하지 않는다', () => {
    renderHook(() => useWarmPastCandles(null, 'KRX'));
    vi.advanceTimersByTime(5000);
    expect(apiAction).not.toHaveBeenCalled();
  });

  it('빠른 탭 전환은 마지막 code로 합쳐진다', () => {
    const { rerender } = renderHook(
      ({ code }: { code: string }) => useWarmPastCandles(code, 'KRX'),
      { initialProps: { code: '005930' } },
    );
    vi.advanceTimersByTime(500);
    rerender({ code: '000660' });
    vi.advanceTimersByTime(1500);
    expect(apiAction).toHaveBeenCalledTimes(1);
    expect(apiAction).toHaveBeenCalledWith(
      '/api/live/warm-past-candles?code=000660&venue=KRX',
      { method: 'POST' },
    );
  });

  it('요청이 거부돼도(예: 503) 조용히 삼킨다', async () => {
    vi.mocked(apiAction).mockRejectedValueOnce(new Error('503'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      renderHook(() => useWarmPastCandles('005930', 'KRX'));
      await vi.advanceTimersByTimeAsync(1500);
      expect(apiAction).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    // 마이크로태스크 배수 후에도 미처리 거부가 없어야 한다.
    await Promise.resolve();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('venue만 바뀌어도 새 venue로 재발사한다', () => {
    const { rerender } = renderHook(
      ({ venue }: { venue: 'KRX' | 'UN' }) => useWarmPastCandles('005930', venue),
      { initialProps: { venue: 'KRX' as 'KRX' | 'UN' } },
    );
    vi.advanceTimersByTime(1500);
    expect(apiAction).toHaveBeenLastCalledWith(
      '/api/live/warm-past-candles?code=005930&venue=KRX',
      { method: 'POST' },
    );
    rerender({ venue: 'UN' });
    vi.advanceTimersByTime(1500);
    expect(apiAction).toHaveBeenCalledTimes(2);
    expect(apiAction).toHaveBeenLastCalledWith(
      '/api/live/warm-past-candles?code=005930&venue=UN',
      { method: 'POST' },
    );
  });
});
