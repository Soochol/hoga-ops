import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useOrderQuantity } from './useOrderQuantity';

describe('주문수량 기억의 컨텍스트 전환', () => {
  it('기본 계좌가 늦게 도착해도 입력을 유지하고 실제 계좌 번호로 기억한다', () => {
    const { result, rerender } = renderHook(({ code, account }) => useOrderQuantity(code, account, true, 10),
      { initialProps: { code: '005930', account: 0 } });
    act(() => result.current[1](30));
    rerender({ code: '005930', account: 1 });
    expect(result.current[0]).toBe(30);
    rerender({ code: '000660', account: 1 });
    expect(result.current[0]).toBeNull();
    rerender({ code: '005930', account: 1 });
    expect(result.current[0]).toBe(30);
    rerender({ code: '005930', account: 2 });
    expect(result.current[0]).toBeNull();
  });

  it('유효하지 않은 입력은 다른 종목에서 돌아와도 복원하지 않는다', () => {
    const { result, rerender } = renderHook(({ code }) => useOrderQuantity(code, 1, true, 10),
      { initialProps: { code: '005930' } });
    for (const quantity of [0, -1, 1.5, NaN, Infinity, 1_000_000_001]) {
      act(() => result.current[1](quantity));
      rerender({ code: '000660' });
      rerender({ code: '005930' });
      expect(result.current[0]).toBeNull();
    }
  });
});
