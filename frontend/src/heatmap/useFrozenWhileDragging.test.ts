import { renderHook } from '@testing-library/react';
import { it, expect } from 'vitest';
import { useFrozenWhileDragging } from './useFrozenWhileDragging';

it('frozen=false → 항상 최신값 통과', () => {
  const { result, rerender } = renderHook(
    ({ v, f }) => useFrozenWhileDragging(v, f), { initialProps: { v: 'a', f: false } });
  expect(result.current).toBe('a');
  rerender({ v: 'b', f: false });
  expect(result.current).toBe('b');
});

it('frozen=true 동안 freeze 시점 값 고정, 해제 시 최신 재개', () => {
  const { result, rerender } = renderHook(
    ({ v, f }) => useFrozenWhileDragging(v, f), { initialProps: { v: 'a', f: false } });
  rerender({ v: 'a', f: true });   // 'a'에서 freeze
  rerender({ v: 'b', f: true });   // 값 바뀌어도 frozen → 'a' 유지
  expect(result.current).toBe('a');
  rerender({ v: 'c', f: false });  // 해제 → 최신
  expect(result.current).toBe('c');
});
