import { describe, it, expect } from 'vitest';

import { formatKoreanInt, formatKoreanK, formatKoreanWonEok } from './koreanNumber';

describe('formatKoreanInt', () => {
  it('rounds and thousands-separates with ko-KR', () => {
    expect(formatKoreanInt(311400)).toBe('311,400');
    expect(formatKoreanInt(-1061741)).toBe('-1,061,741');
    expect(formatKoreanInt(1234.7)).toBe('1,235');
    expect(formatKoreanInt(0)).toBe('0');
  });
});

describe('formatKoreanK', () => {
  it('rounds quantities to an integer K value', () => {
    expect(formatKoreanK(1_234_567)).toBe('1,235K');
    expect(formatKoreanK(-12_500)).toBe('-12K');
    expect(formatKoreanK(500)).toBe('1K');
  });
});

describe('formatKoreanWonEok', () => {
  it('formats won amounts in readable eok units', () => {
    expect(formatKoreanWonEok(169_039_074_500)).toBe('1,690억');
    expect(formatKoreanWonEok(-806_001_750)).toBe('-8.06억');
    expect(formatKoreanWonEok(1_230_000_000)).toBe('12.3억');
    expect(formatKoreanWonEok(0)).toBe('0억');
  });
});
