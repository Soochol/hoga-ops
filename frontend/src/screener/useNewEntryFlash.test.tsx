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

  it('null(결과 없음)을 거치면 다음 채움은 첫 조회 취급 — 전체 플래시 안 함', () => {
    const { result, rerender } = renderHook(
      (codes: string[] | null) => useNewEntryFlash(codes),
      { initialProps: ['005930'] as string[] | null },
    );
    act(() => { rerender(null); });                     // 시작 = 결과 초기화
    act(() => { rerender(['005930', '000660']); });     // 새 스캔 결과 도착
    expect(result.current.size).toBe(0);
  });

  it('빈 배열(결과 0건)은 null 과 달라 다음 편입을 플래시한다', () => {
    const { result, rerender } = renderHook(
      (codes: string[] | null) => useNewEntryFlash(codes),
      { initialProps: ['005930'] as string[] | null },
    );
    act(() => { rerender([]); });                       // 조건 통과 종목이 사라짐
    act(() => { rerender(['000660']); });               // 실제 신규 편입
    expect([...result.current]).toEqual(['000660']);
  });

  it('초기화 시 진행 중이던 플래시를 즉시 걷는다', () => {
    const { result, rerender } = renderHook(
      (codes: string[] | null) => useNewEntryFlash(codes),
      { initialProps: ['005930'] as string[] | null },
    );
    act(() => { rerender(['005930', '000660']); });
    expect(result.current.has('000660')).toBe(true);
    act(() => { rerender(null); });
    expect(result.current.size).toBe(0);
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
