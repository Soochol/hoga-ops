import { describe, it, expect } from 'vitest';
import { formatQtyCompact } from './formatQtyCompact';

describe('formatQtyCompact', () => {
  it('< 1,000은 천단위 콤마', () => {
    expect(formatQtyCompact(999)).toBe('999');
    expect(formatQtyCompact(0)).toBe('0');
  });
  it('k 단위 한 자리 소수', () => {
    expect(formatQtyCompact(13_600)).toBe('13.6k');
    expect(formatQtyCompact(153_125)).toBe('153.1k');
    expect(formatQtyCompact(1_000)).toBe('1k');
    expect(formatQtyCompact(32_621)).toBe('32.6k');
  });
  it('M 단위 한 자리 소수', () => {
    expect(formatQtyCompact(1_234_567)).toBe('1.2M');
    expect(formatQtyCompact(1_000_000)).toBe('1M');
  });
  it('음수·비정상은 0', () => {
    expect(formatQtyCompact(-5)).toBe('0');
    expect(formatQtyCompact(Number.NaN)).toBe('0');
  });
});
