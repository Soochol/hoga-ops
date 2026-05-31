import { describe, it, expect } from 'vitest';

import { formatKoreanInt } from './koreanNumber';

describe('formatKoreanInt', () => {
  it('rounds and thousands-separates with ko-KR', () => {
    expect(formatKoreanInt(311400)).toBe('311,400');
    expect(formatKoreanInt(-1061741)).toBe('-1,061,741');
    expect(formatKoreanInt(1234.7)).toBe('1,235');
    expect(formatKoreanInt(0)).toBe('0');
  });
});
