import { describe, it, expect } from 'vitest';
import { formatMs, formatPercent, formatEventCount } from './timingFormat';

describe('formatMs', () => {
  it('shows ms for values under 950', () => {
    expect(formatMs(234)).toBe('234 ms');
    expect(formatMs(0)).toBe('0 ms');
    expect(formatMs(949)).toBe('949 ms');
  });
  it('shows s with one decimal at and above 950', () => {
    expect(formatMs(950)).toBe('1.0 s');
    expect(formatMs(1000)).toBe('1.0 s');
    expect(formatMs(12_345)).toBe('12.3 s');
    expect(formatMs(43_821.4)).toBe('43.8 s');
  });
});

describe('formatPercent', () => {
  it('rounds to 1 decimal place', () => {
    expect(formatPercent(71.23)).toBe('71.2 %');
    expect(formatPercent(0)).toBe('0.0 %');
    expect(formatPercent(100)).toBe('100.0 %');
  });
});

describe('formatEventCount', () => {
  it('uses ko-KR thousand separators', () => {
    expect(formatEventCount(184231)).toBe('184,231');
    expect(formatEventCount(0)).toBe('0');
    expect(formatEventCount(7)).toBe('7');
  });
});
