import { describe, expect, it } from 'vitest';
import {
  clearLiveWindowStatus,
  publishLiveWindowStatus,
  useLiveWindowStatus,
} from './liveWindowStatusSource';
import { renderHook, act } from '@testing-library/react';

function status(windowId: string) {
  return {
    windowId,
    workareaCode: '005930',
    bundle: null,
    liveTradePrice: 1000,
    isExtending: false,
    historicalFromDate: null,
    hogaGapDates: [] as const,
  };
}

describe('liveWindowStatusSource — 포커스 창 발행 채널 (C2c-2c)', () => {
  it('발행 → 구독자가 최신 발행을 본다', () => {
    const { result } = renderHook(() => useLiveWindowStatus());
    act(() => publishLiveWindowStatus(status('w1')));
    expect(result.current?.windowId).toBe('w1');
  });

  it('clear 는 자기 발행일 때만 걷는다 — 포커스 교체 직후 이전 창 cleanup 무해', () => {
    const { result } = renderHook(() => useLiveWindowStatus());
    act(() => publishLiveWindowStatus(status('w1')));
    act(() => publishLiveWindowStatus(status('w2'))); // 포커스 이동: w2 가 교체 발행
    act(() => clearLiveWindowStatus('w1')); // w1 의 늦은 cleanup
    expect(result.current?.windowId).toBe('w2'); // w2 발행은 살아있다
    act(() => clearLiveWindowStatus('w2'));
    expect(result.current).toBeNull();
  });
});
