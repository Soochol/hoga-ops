import { describe, it, expect } from 'vitest';
import { tradingDayOf } from './tradingDay';

describe('tradingDayOf', () => {
  it('같은 KST 거래일(09:00~15:30)은 같은 번호', () => {
    const kst0900 = Date.UTC(2026, 5, 13, 0, 0); // 00:00 UTC = 09:00 KST
    const kst1530 = Date.UTC(2026, 5, 13, 6, 30); // 06:30 UTC = 15:30 KST
    expect(tradingDayOf(kst0900)).toBe(tradingDayOf(kst1530));
  });

  it('KST 자정 경계에서 번호가 +1', () => {
    const beforeMidnightKst = Date.UTC(2026, 5, 13, 14, 59); // 23:59 KST 06-13
    const afterMidnightKst = Date.UTC(2026, 5, 13, 15, 0); //   00:00 KST 06-14
    expect(tradingDayOf(afterMidnightKst)).toBe(tradingDayOf(beforeMidnightKst) + 1);
  });

  it('UTC 자정 경계(KST 09:00 중)에서는 안 바뀐다', () => {
    const a = Date.UTC(2026, 5, 13, 23, 59); // 08:59 KST 06-14
    const b = Date.UTC(2026, 5, 14, 0, 1); //   09:01 KST 06-14
    expect(tradingDayOf(a)).toBe(tradingDayOf(b));
  });
});
