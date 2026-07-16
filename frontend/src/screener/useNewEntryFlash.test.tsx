import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { useNewEntryFlash, NEW_ENTRY_FLASH_MS } from './useNewEntryFlash';

describe('useNewEntryFlash', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

  it('첫 조회는 플래시하지 않는다(전체 노이즈 방지)', () => {
    const { result } = renderHook((codes: string[]) => useNewEntryFlash(codes), {
      initialProps: ['005930', '000660'],
    });
    expect(result.current.size).toBe(0);
  });

  it('재조회로 새로 편입된 코드만 플래시한다', () => {
    const { result, rerender } = renderHook((codes: string[]) => useNewEntryFlash(codes), {
      initialProps: ['005930'],
    });
    act(() => { rerender(['005930', '000660']); });   // 000660 신규
    expect([...result.current]).toEqual(['000660']);   // 기존 005930 은 플래시 안 함
  });

  it('holdMs 경과 후 플래시가 자동으로 사라진다', () => {
    const { result, rerender } = renderHook((codes: string[]) => useNewEntryFlash(codes), {
      initialProps: ['005930'],
    });
    act(() => { rerender(['005930', '000660']); });
    expect(result.current.has('000660')).toBe(true);
    act(() => { vi.advanceTimersByTime(NEW_ENTRY_FLASH_MS + 10); });
    expect(result.current.has('000660')).toBe(false);
  });

  it('이탈했다 재진입하면 다시 플래시한다', () => {
    const { result, rerender } = renderHook((codes: string[]) => useNewEntryFlash(codes), {
      initialProps: ['005930', '000660'],
    });
    act(() => { rerender(['005930']); });              // 000660 이탈
    act(() => { vi.advanceTimersByTime(NEW_ENTRY_FLASH_MS + 10); });
    act(() => { rerender(['005930', '000660']); });    // 000660 재진입 → 신규 취급
    expect(result.current.has('000660')).toBe(true);
  });
});
