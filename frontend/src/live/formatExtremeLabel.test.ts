import { describe, it, expect } from 'vitest';
import { formatExtremeLabel } from './formatExtremeLabel';

// KST = UTC + 9h. "06.12 09:51 KST" → UTC 00:51 → Date.UTC(2026,5,12,0,51).
const TS_0951_KST = Date.UTC(2026, 5, 12, 0, 51, 0);
const TS_1451_KST = Date.UTC(2026, 5, 12, 5, 51, 0);

describe('formatExtremeLabel', () => {
  it('formats a minute high label (negative 극값 대비율)', () => {
    expect(formatExtremeLabel(38_800, -4.379, TS_0951_KST, '1m')).toBe(
      '38,800원 (-4.38%, 06.12 09:51)',
    );
  });

  it('formats a minute low label (positive 극값 대비율, leading +)', () => {
    expect(formatExtremeLabel(36_750, 0.952, TS_1451_KST, '5m')).toBe(
      '36,750원 (+0.95%, 06.12 14:51)',
    );
  });

  it('omits the time on calendar timeframes (D/W/M)', () => {
    expect(formatExtremeLabel(38_800, -4.38, TS_0951_KST, 'D')).toBe('38,800원 (-4.38%, 06.12)');
  });

  it('uses the +9h KST rule across the midnight boundary (no 9h drift)', () => {
    // KST 2026-06-12 00:05 = UTC 2026-06-11 15:05. Must read as 06.12 00:05, not 06.11.
    const tsMidnight = Date.UTC(2026, 5, 11, 15, 5, 0);
    expect(formatExtremeLabel(10_000, 1.0, tsMidnight, '1m')).toBe('10,000원 (+1.00%, 06.12 00:05)');
  });

  it('groups thousands in the price and renders +0.00 at zero', () => {
    expect(formatExtremeLabel(1_234_567, 0, TS_0951_KST, '1m')).toBe(
      '1,234,567원 (+0.00%, 06.12 09:51)',
    );
  });
});
