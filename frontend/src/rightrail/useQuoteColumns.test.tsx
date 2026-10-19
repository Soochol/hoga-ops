import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useQuoteColumns } from './useQuoteColumns';

const scrollRef = { current: null };
type Values = { code: string; price: number | null; change_pct: number | null; expected_price?: number };
const values = (rows: Values[]) => new Map(rows.map(row => [row.code, row]));
const large = { code: '005930', price: 123456789, change_pct: -1234.56, expected_price: 1234567890 };
const small = { code: '005930', price: 12, change_pct: 1 };

describe('useQuoteColumns scope', () => {
  it('keeps actual/expected and signed budgets through shrink, removal and empty/loading results in the same condition', () => {
    const { result, rerender } = renderHook(({ rows, scope }: { rows: Values[]; scope: string | null }) =>
      useQuoteColumns(rows.map(row => row.code), values(rows), scrollRef, scope),
    { initialProps: { rows: [large] as Values[], scope: 'condition-a' as string | null } });
    const samples = result.current.samples;
    expect(samples.price).toContain('888,888,888');
    expect(samples.price).toContain('8,888,888,888');
    expect(samples.percent).toContain('+8888.88%');
    expect(samples.percent).toContain('-8888.88%');
    rerender({ rows: [small], scope: 'condition-a' });
    expect(result.current.samples.price).toContain('8,888,888,888');
    rerender({ rows: [], scope: 'condition-a' });
    expect(result.current.samples.percent).toContain('-8888.88%');
    rerender({ rows: [], scope: null });
    expect(result.current.samples.price).toContain('8,888,888,888');
    rerender({ rows: [small], scope: 'condition-a' });
    expect(result.current.samples.price).toContain('8,888,888,888');
  });

  it('starts a new budget only when a different result scope arrives', () => {
    const { result, rerender } = renderHook(({ row, scope }) =>
      useQuoteColumns([row.code], values([row]), scrollRef, scope),
    { initialProps: { row: large as Values, scope: 'condition-a' } });
    rerender({ row: small, scope: 'condition-b' });
    expect(result.current.samples.price).toEqual(['—', '88']);
    expect(result.current.samples.percent).not.toContain('-8888.88%');
    rerender({ row: { ...small, price: null, change_pct: null }, scope: 'condition-b' });
    expect(result.current.samples.price).toEqual(['—', '88']);
  });
});
