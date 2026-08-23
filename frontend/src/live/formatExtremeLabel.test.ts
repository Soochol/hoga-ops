import { describe, it, expect } from 'vitest';
import { formatExtremeLabel } from './formatExtremeLabel';

describe('formatExtremeLabel', () => {
  it('formats a high label (negative 극값 대비율)', () => {
    expect(formatExtremeLabel(38_800, -4.379)).toBe('38,800원 (-4.38%)');
  });

  it('formats a low label (positive 극값 대비율, leading +)', () => {
    expect(formatExtremeLabel(36_750, 0.952)).toBe('36,750원 (+0.95%)');
  });

  it('groups thousands in the price and renders +0.00 at zero', () => {
    expect(formatExtremeLabel(1_234_567, 0)).toBe('1,234,567원 (+0.00%)');
  });

  it('carries no timestamp — the chip width is the candle area it covers', () => {
    // 2026-08-23 결정의 가드: 시각(MM.DD HH:MM)을 되돌리면 여기서 빨개진다. 폭이
    // 곧 캔들을 덮는 면적이라 이 칩에서 문자 수는 코스메틱이 아니다.
    const text = formatExtremeLabel(38_800, -4.38);
    expect(text).not.toMatch(/\d{2}\.\d{2}/);
    expect(text).not.toMatch(/\d{2}:\d{2}/);
    expect(text.length).toBeLessThanOrEqual(20);
  });
});
