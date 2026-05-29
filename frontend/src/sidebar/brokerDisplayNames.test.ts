import { describe, it, expect } from 'vitest';
import { brokerDisplayShort } from './brokerDisplayNames';

describe('brokerDisplayShort', () => {
  describe('automatic "strip 증권 + cap at 4 chars" rule', () => {
    it.each([
      // Common case: strip 증권 suffix
      ['신한투자증권', '신한투자'],
      ['한국투자증권', '한국투자'],
      ['미래에셋증권', '미래에셋'],
      ['삼성증권', '삼성'],
      ['키움증권', '키움'],
      ['NH투자증권', 'NH투자'],
      ['KB증권', 'KB'],
      ['유안타증권', '유안타'],
      ['신영증권', '신영'],
      ['하나증권', '하나'],
      ['토스증권', '토스'],
    ])('strips 증권 from %s -> %s', (canonical, expected) => {
      expect(brokerDisplayShort(canonical)).toBe(expected);
    });

    it('handles unknown canonical name with the automatic rule', () => {
      // New brokers added to backend _CANONICAL need no frontend change.
      expect(brokerDisplayShort('새로운증권')).toBe('새로운');
    });

    it('passes through short names without 증권 suffix', () => {
      expect(brokerDisplayShort('짧음')).toBe('짧음');
      expect(brokerDisplayShort('JP모간')).toBe('JP모간');
      expect(brokerDisplayShort('골드만')).toBe('골드만');
      expect(brokerDisplayShort('씨티그룹')).toBe('씨티그룹');
    });

    it('caps long names without 증권 suffix at 4 chars', () => {
      expect(brokerDisplayShort('다섯글자다')).toBe('다섯글자');
    });
  });

  describe('explicit overrides', () => {
    it('uses override when automatic rule would produce awkward label', () => {
      // 모건스탠리증권 -> strip -> 모건스탠리 (5 chars) -> would slice to 모건스탠
      // The override is the same, but kept explicit so the intent (extra
      // abbreviation beyond simple strip) is documented.
      expect(brokerDisplayShort('모건스탠리증권')).toBe('모건스탠');
    });

    it('overrides 코리아에셋 (no 증권 suffix, 5 chars)', () => {
      expect(brokerDisplayShort('코리아에셋')).toBe('코리아');
    });
  });
});
