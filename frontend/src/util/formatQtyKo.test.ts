import { describe, it, expect } from 'vitest';
import { formatQtyKo } from './formatQtyKo';

describe('formatQtyKo', () => {
  it('< 1만은 천단위 구분', () => {
    expect(formatQtyKo(9_999)).toBe('9,999');
    expect(formatQtyKo(0)).toBe('0');
  });
  it('만 단위 한 자리 소수', () => {
    expect(formatQtyKo(123_456)).toBe('12.3만');
    expect(formatQtyKo(10_000)).toBe('1만');
  });
  it('억 단위 한 자리 소수', () => {
    expect(formatQtyKo(123_456_789)).toBe('1.2억');
    expect(formatQtyKo(100_000_000)).toBe('1억');
  });
  it('음수·비정상은 0', () => {
    expect(formatQtyKo(-5)).toBe('0');
    expect(formatQtyKo(Number.NaN)).toBe('0');
  });
});
