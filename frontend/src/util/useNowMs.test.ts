import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useNowMs } from './useNowMs';

describe('useNowMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T04:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('advances on each interval tick', () => {
    const { result } = renderHook(() => useNowMs(1000));
    const first = result.current;
    expect(first).toBe(Date.parse('2026-07-08T04:00:00Z'));
    // advancing the fake clock 3s fires the 1s interval and moves Date.now().
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current).toBe(Date.parse('2026-07-08T04:00:03Z'));
    expect(result.current).toBeGreaterThan(first);
  });

  it('clears the interval on unmount (no tick after)', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderHook(() => useNowMs(1000));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});
