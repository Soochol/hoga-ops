import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBookPriceLayout } from './useBookPriceLayout';

it('retains the widest ladder price through smaller quotes and resets for another symbol', () => {
  const { result, rerender } = renderHook(({ symbol, prices }) =>
    useBookPriceLayout(prices.map(price => ({ price })), symbol, true),
  { initialProps: { symbol: 'A', prices: [67_200] } });
  const short = result.current;
  rerender({ symbol: 'A', prices: [9_999_000, 10_000_000] });
  const expanded = result.current;
  expect(expanded).not.toEqual(short);
  rerender({ symbol: 'A', prices: [9_999_000] });
  expect(result.current).toEqual(expanded);
  rerender({ symbol: 'A', prices: [] });
  expect(result.current).toEqual(expanded);
  rerender({ symbol: 'B', prices: [67_200] });
  expect(result.current).toEqual(short);
});

describe('invalid levels', () => {
  it('ignores missing, non-finite and unsafe prices when reserving width', () => {
    const { result, rerender } = renderHook(({ prices }) =>
      useBookPriceLayout(prices.map(price => ({ price })), 'A', false),
    { initialProps: { prices: [67_200] } });
    const valid = result.current;
    rerender({ prices: [0, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1] });
    expect(result.current).toEqual(valid);
  });
});

it('retains percentage width when the rate loses a digit or crosses zero', () => {
  const { result, rerender } = renderHook(({ price, symbol }) =>
    useBookPriceLayout([{ price }], symbol, true, 66_000),
  { initialProps: { price: 67_200, symbol: 'A' } });
  const narrow = result.current;
  rerender({ price: 80_000, symbol: 'A' });
  const wide = result.current;
  expect(wide).not.toEqual(narrow);
  rerender({ price: 66_000, symbol: 'A' });
  expect(result.current).toEqual(wide);
  rerender({ price: 67_200, symbol: 'B' });
  expect(result.current).toEqual(narrow);
});

it('등락률을 숨기면 예약 열 폭을 줄이고 다시 켜면 기존 가격·등락률 폭을 복원한다', () => {
  const { result, rerender } = renderHook(({ showPercent }) =>
    useBookPriceLayout([{ price: 67200 }], 'A', true, 66000, showPercent),
  { initialProps: { showPercent: true } });
  const visible = result.current;
  rerender({ showPercent: false });
  expect(result.current['--book-price-width' as keyof typeof result.current]).not.toEqual(visible['--book-price-width' as keyof typeof visible]);
  expect(result.current['--book-price-sample' as keyof typeof result.current]).toEqual(visible['--book-price-sample' as keyof typeof visible]);
  rerender({ showPercent: true });
  expect(result.current).toEqual(visible);
});
