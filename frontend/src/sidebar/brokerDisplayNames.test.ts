import { describe, it, expect } from 'vitest';
import { brokerDisplayShort } from './brokerDisplayNames';

describe('brokerDisplayShort', () => {
  it.each([
    ['신한투자증권', '신한투자'],
    ['한국투자증권', '한국투자'],
    ['미래에셋증권', '미래에셋'],
    ['삼성증권', '삼성'],
    ['키움증권', '키움'],
    ['NH투자증권', 'NH투자'],
    ['JP모간', 'JP모간'],
    ['모건스탠리증권', '모건스탠'],
  ])('maps canonical %s to compact label %s', (canonical, expected) => {
    expect(brokerDisplayShort(canonical)).toBe(expected);
  });

  it('falls back to slice(0,4) for unknown long canonical name', () => {
    expect(brokerDisplayShort('긴이름증권')).toBe('긴이름증');
  });

  it('returns short names unchanged', () => {
    expect(brokerDisplayShort('짧음')).toBe('짧음');
    expect(brokerDisplayShort('JP모간')).toBe('JP모간');
  });
});
