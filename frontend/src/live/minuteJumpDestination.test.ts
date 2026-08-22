import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jumpDestinationOf, jumpTargetMs } from './minuteJumpDestination';
import { earliestAllowedMinuteDate, realMsToYyyymmdd, todayKstYyyymmdd } from './liveDateTime';

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
  /** 벤더 모드 분봉 창의 하한(250일 벽) — `useLiveBundle` 이 주는 값과 같은 모양. */
  const VENDOR_FLOOR = earliestAllowedMinuteDate(todayKstYyyymmdd());

  it('값이 없거나 유한하지 않으면 null', () => {
    expect(jumpDestinationOf(null, VENDOR_FLOOR)).toBeNull();
    expect(jumpDestinationOf(Number.NaN, VENDOR_FLOOR)).toBeNull();
  });

  it('오늘은 갈 수 있다', () => {
    expect(jumpDestinationOf(NOW, VENDOR_FLOOR))
      .toEqual({ date: '20260822', outOfRetention: false });
  });

  // 경계 밖 한참 떨어진 값만 재면 "항상 false" 구현도 통과한다 — 하한의
  // **양옆 하루**를 세워야 그 값을 실제로 쓰는지 알 수 있다.
  it('하한 경계의 양옆에서 판정이 갈린다', () => {
    const edgeMs = kstNoonMs(VENDOR_FLOOR);
    expect(jumpDestinationOf(edgeMs, VENDOR_FLOOR))
      .toEqual({ date: VENDOR_FLOOR, outOfRetention: false });
    const dayBefore = jumpDestinationOf(edgeMs - DAY_MS, VENDOR_FLOOR);
    expect(dayBefore!.date < VENDOR_FLOOR).toBe(true);
    expect(dayBefore!.outOfRetention).toBe(true);
  });

  it('한참 과거는 갈 수 없다', () => {
    expect(jumpDestinationOf(NOW - 400 * DAY_MS, VENDOR_FLOOR)?.outOfRetention).toBe(true);
  });

  // ⚠ 이 케이스가 #1497 회귀 가드다. 하한을 하드코딩된 250일 벽으로 되돌리면
  // 디스크 모드(하한 없음) 창에서 **갈 수 있는 곳을 못 간다고** 말하게 된다.
  it('하한이 null 이면(디스크 모드·미측정) 막지 않는다 — 모르는 것을 못 간다고 하지 않는다', () => {
    expect(jumpDestinationOf(NOW - 400 * DAY_MS, null))
      .toEqual({ date: realMsToYyyymmdd(NOW - 400 * DAY_MS), outOfRetention: false });
    expect(jumpDestinationOf(NOW - 2000 * DAY_MS, null)?.outOfRetention).toBe(false);
  });

  it('하한이 더 과거면 그만큼 더 갈 수 있다 — 값이 실제로 판정에 쓰인다', () => {
    const old = NOW - 400 * DAY_MS;
    const deepFloor = realMsToYyyymmdd(NOW - 900 * DAY_MS);
    expect(jumpDestinationOf(old, VENDOR_FLOOR)?.outOfRetention).toBe(true);
    expect(jumpDestinationOf(old, deepFloor)?.outOfRetention).toBe(false);
  });
});

/**
 * 착지 규칙은 **사용자 결정**이라(2026-08-22: 「일봉 뷰의 가장 오른쪽 캔들」) 회귀를
 * 여기서 막는다. 종전에 앞서 있던 호버 우선순위가 되살아나면 이 케이스들이 빨개진다.
 */
describe('jumpTargetMs — 보이는 가장 오른쪽 캔들', () => {
  const c = (ts: number) => ({ ts_ms: ts });
  //  09-01      09-02      09-03      09-04
  const CANDLES = [c(1_000), c(2_000), c(3_000), c(4_000)];

  it('뷰 우측 끝 **이하의 마지막 캔들**을 고른다 — 화면 중간을 보고 있으면 그 끝', () => {
    expect(jumpTargetMs(CANDLES, 3_000)).toBe(3_000);
    // 우측 끝이 캔들과 캔들 사이여도 그 이하의 마지막 봉으로 내린다.
    expect(jumpTargetMs(CANDLES, 3_500)).toBe(3_000);
  });

  it('우측 여백을 보고 있으면 최신 캔들 — 그게 「보이는 가장 오른쪽 캔들」이다', () => {
    expect(jumpTargetMs(CANDLES, 9_999)).toBe(4_000);
  });

  it('뷰를 측정할 수 없으면 최신 캔들로 떨어진다', () => {
    expect(jumpTargetMs(CANDLES, null)).toBe(4_000);
    expect(jumpTargetMs(CANDLES, Number.NaN)).toBe(4_000);
  });

  it('캔들이 없으면 null — 보낼 곳이 없다', () => {
    expect(jumpTargetMs([], 3_000)).toBeNull();
  });

  // 판별력: 우측 끝을 옮기면 결과가 **따라 움직여야** 한다. 이게 없으면 "항상 최신
  // 캔들" 인 구현도 위 케이스 절반을 통과한다.
  it('우측 끝이 움직이면 목적지도 함께 움직인다', () => {
    expect(jumpTargetMs(CANDLES, 2_000)).toBe(2_000);
    expect(jumpTargetMs(CANDLES, 1_000)).toBe(1_000);
  });

  // 폴백이 둘이고 **방향이 반대**다. 뭉개면 "과거를 보려고 팬했는데 오늘로 끌려가는"
  // 정반대 동작이 된다 — 이 케이스가 그것을 잡았다.
  it('뷰 전체가 데이터보다 과거면 **첫** 캔들 — 팬한 방향과 같은 쪽이다', () => {
    expect(jumpTargetMs(CANDLES, 500)).toBe(1_000);
  });

  it('측정 불가와 좌측 여백은 서로 다른 쪽으로 떨어진다', () => {
    expect(jumpTargetMs(CANDLES, null)).toBe(4_000);   // 화면을 모른다 → 라이브 엣지
    expect(jumpTargetMs(CANDLES, 500)).toBe(1_000);    // 과거를 본다 → 데이터 왼쪽 끝
  });
});
