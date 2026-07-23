import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  publishWindowWarnings,
  clearWindowWarnings,
  useWindowWarnings,
} from './windowWarningsSource';

describe('windowWarningsSource', () => {
  beforeEach(() => {
    clearWindowWarnings('w1');
    clearWindowWarnings('w2');
  });

  it('returns empty defaults for an unpublished window (stable reference)', () => {
    const { result, rerender } = renderHook(() => useWindowWarnings('w1'));
    expect(result.current.hogaGapDates).toEqual([]);
    expect(result.current.backfillEarliestDate).toBeNull();
    const first = result.current;
    rerender();
    // 같은 참조여야 무한 렌더가 안 난다.
    expect(result.current).toBe(first);
  });

  it('delivers published warnings to the matching window only', () => {
    const w1 = renderHook(() => useWindowWarnings('w1'));
    const w2 = renderHook(() => useWindowWarnings('w2'));

    act(() => {
      publishWindowWarnings('w1', { hogaGapDates: ['20260520', '20260521'], backfillEarliestDate: '20260501' });
    });

    expect(w1.result.current.hogaGapDates).toEqual(['20260520', '20260521']);
    expect(w1.result.current.backfillEarliestDate).toBe('20260501');
    // w2 는 영향 없음(창별 격리).
    expect(w2.result.current.hogaGapDates).toEqual([]);
    expect(w2.result.current.backfillEarliestDate).toBeNull();
  });

  it('clears warnings back to defaults on unmount/clear', () => {
    const { result } = renderHook(() => useWindowWarnings('w1'));
    act(() => {
      publishWindowWarnings('w1', { hogaGapDates: ['20260520'], backfillEarliestDate: null });
    });
    expect(result.current.hogaGapDates).toEqual(['20260520']);
    act(() => clearWindowWarnings('w1'));
    expect(result.current.hogaGapDates).toEqual([]);
  });
});
