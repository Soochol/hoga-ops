import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jumpDestinationOf } from './minuteJumpDestination';
import { earliestAllowedMinuteDate, todayKstYyyymmdd } from './liveDateTime';

const NOW = new Date('2026-08-22T05:00:00Z').getTime(); // KST 14:00
const DAY_MS = 24 * 60 * 60 * 1000;

/** `yyyymmdd` 의 KST 정오 — 날짜만 보는 판정이라 시각은 아무 값이나 되지만,
 *  정오로 두면 UTC 로 밀려도 같은 KST 날짜에 남는다. */
function kstNoonMs(yyyymmdd: string): number {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  return Date.UTC(y, m - 1, d, 3, 0, 0); // 12:00 KST
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('jumpDestinationOf', () => {
  it('값이 없거나 유한하지 않으면 null', () => {
    expect(jumpDestinationOf(null)).toBeNull();
    expect(jumpDestinationOf(Number.NaN)).toBeNull();
  });

  it('오늘은 갈 수 있다', () => {
    expect(jumpDestinationOf(NOW)).toEqual({ date: '20260822', outOfRetention: false });
  });

  // 경계 밖 한참 떨어진 값만 재면 "항상 false" 구현도 통과한다 — 한계선의
  // **양옆 하루**를 세워야 그 상수를 실제로 쓰는지 알 수 있다.
  it('보유 한계 경계의 양옆에서 판정이 갈린다', () => {
    const edge = earliestAllowedMinuteDate(todayKstYyyymmdd());
    const edgeMs = kstNoonMs(edge);
    expect(jumpDestinationOf(edgeMs)).toEqual({ date: edge, outOfRetention: false });
    const dayBefore = jumpDestinationOf(edgeMs - DAY_MS);
    expect(dayBefore!.date < edge).toBe(true);
    expect(dayBefore!.outOfRetention).toBe(true);
  });

  it('한참 과거는 갈 수 없다', () => {
    expect(jumpDestinationOf(NOW - 400 * DAY_MS)?.outOfRetention).toBe(true);
  });
});
