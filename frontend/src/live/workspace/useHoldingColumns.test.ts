import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useHoldingColumnMemory, useHoldingColumns } from './useHoldingColumns';

it('retains whole formatted columns across smaller or empty observations and resets on account change', () => {
  const small = { quantity: ['22'], average: ['180,000'], value: ['4,070,000'], profit: ['+110,000원', '-110,000원'], percent: ['+2.78%', '-2.78%'] };
  const large = { quantity: ['100,000,000'], average: ['900,000'], value: ['100,000,000,000,000'],
    profit: ['+10,000,000,000,000원', '-10,000,000,000,000원'], percent: ['+11.11%', '-11.11%'] };
  const empty = { quantity: [], average: [], value: [], profit: [], percent: [] };
  const { result, rerender } = renderHook(({ account, values }) => useHoldingColumns(useHoldingColumnMemory(account), values),
    { initialProps: { account: 1, values: small } });
  rerender({ account: 1, values: large });
  const retained = result.current.samples;
  expect(retained.value).toContain('888,888,888,888,888');
  expect(retained.profit).toContain('-88,888,888,888,888원');
  expect(retained.percent).toContain('+88.88%');
  rerender({ account: 1, values: small });
  expect(result.current.samples).toEqual(retained);
  rerender({ account: 1, values: empty });
  expect(result.current.samples).toEqual(retained);
  rerender({ account: 2, values: small });
  expect(result.current.samples.value).not.toContain('888,888,888,888,888');
  expect(result.current.samples.value).toContain('8,888,888');
});
