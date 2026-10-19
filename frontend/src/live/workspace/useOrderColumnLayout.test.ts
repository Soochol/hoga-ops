import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useOrderColumnLayout } from './useOrderColumnLayout';

describe('useOrderColumnLayout', () => {
  it('retains full quantity, signed delta and fill samples until the Code/account changes', () => {
    const { result, rerender } = renderHook(({ key, large }) => useOrderColumnLayout(key,
      [large ? 123456789 : 100], [large ? -12345678 : 0],
      [{ price: large ? 1234567 : 99900, qty: large ? 12345678 : 10 }], 134.234,
      [large ? 123456789 : 10], large ? 12 : 1, false),
    { initialProps: { key: 'account-1:005930', large: false } });
    const small = result.current.samples;
    rerender({ key: 'account-1:005930', large: true });
    const large = result.current.samples;
    expect(large.qty).toBe('888,888,888');
    expect(large.delta).toBe('88,888,888');
    expect(large.price).toBe('8,888,888');
    expect(large.trade).toBe('88,888,888');
    expect(large.strength).toBe('888.888%');
    rerender({ key: 'account-1:005930', large: false });
    expect(result.current.samples).toEqual(large);
    rerender({ key: 'account-2:005930', large: false });
    expect(result.current.samples).toEqual(small);
    rerender({ key: 'account-2:005930', large: true });
    rerender({ key: 'account-2:000660', large: false });
    expect(result.current.samples).toEqual(small);
  });

  it('releases transient status text while retaining the numeric and total count budget', () => {
    const { result, rerender } = renderHook(({ pending, key }) => useOrderColumnLayout(key,
      [], [], [], null, [123456789], 123, pending), { initialProps: { pending: true, key: 'a' } });
    expect(result.current.samples.order).toBe('888,888,888 · 처리 중');
    expect(result.current.samples.total).toBe('888,888,888(888)');
    rerender({ pending: false, key: 'a' });
    expect(result.current.samples.order).toBe('888,888,888');
    rerender({ pending: false, key: 'b' });
    expect(result.current.samples.order).toBe('888,888,888');
  });
});
