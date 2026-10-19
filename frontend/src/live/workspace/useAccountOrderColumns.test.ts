import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useAccountOrderColumns } from './useAccountOrderColumns';

it('retains formatted widths after fills or an empty list and resets them for another account', () => {
  const { result, rerender } = renderHook(({ account, prices, quantities }) => useAccountOrderColumns(account, prices, quantities),
    { initialProps: { account: 1, prices: ['1,234.5'], quantities: ['100'] } });
  expect(result.current.samples.price).toContain('8,888.8');
  rerender({ account: 1, prices: ['123,456,789.25'], quantities: ['123,456,789,012,345'] });
  expect(result.current.samples.price).toContain('888,888,888.88');
  expect(result.current.samples.quantity).toContain('888,888,888,888,888');
  const retained = result.current.samples;
  rerender({ account: 1, prices: [], quantities: [] });
  expect(result.current.samples).toEqual(retained);
  rerender({ account: 1, prices: ['1'], quantities: ['1'] });
  expect(result.current.samples.price).toContain('888,888,888.88');
  rerender({ account: 2, prices: ['1'], quantities: ['1'] });
  expect(result.current.samples.price).toEqual(['—', '8']);
  expect(result.current.samples.quantity).toEqual(['—', '8']);
});
