import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucketEndMs, jumpDestinationOf, jumpPublicationRange, jumpTargetMs } from './minuteJumpDestination';
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

/** `yyyy-mm-dd` KST 자정의 Unix ms. `Date.UTC` 는 UTC 자정이라 9시간 당긴다. */
function kstMidnight(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d) - 9 * 60 * 60 * 1000;
}
/** 그 KST 날짜가 덮는 마지막 ms. */
function kstDayLast(y: number, m: number, d: number): number {
  return kstMidnight(y, m, d + 1) - 1;
}

/**
 * 캘린더 칸의 상한. 여기가 F1 의 규칙이다 — 주·월봉의 `ts_ms` 는 칸의 **시작**이라
 * 그대로 목적지로 쓰면 칸의 첫 거래일로 간다(실측 2026-08-23: 주봉 08-18, 월봉 08-03).
 */
describe('bucketEndMs', () => {
  const FAR_FUTURE = kstMidnight(2030, 1, 1);

  it('일봉은 그 날이 끝나는 순간까지', () => {
    expect(bucketEndMs('D', kstMidnight(2026, 8, 21) + 9 * 3_600_000, FAR_FUTURE))
      .toBe(kstDayLast(2026, 8, 21));
  });

  it('주봉은 **그 주 일요일**까지 — 앵커가 화요일이어도(첫 거래일이 휴일로 밀린 주)', () => {
    // 2026-08-17 은 광복절 대체공휴일이라 그 주 첫 거래일이 화요일 08-18 이다.
    expect(bucketEndMs('W', kstMidnight(2026, 8, 18) + 9 * 3_600_000, FAR_FUTURE))
      .toBe(kstDayLast(2026, 8, 23));
  });

  it('앵커가 일요일이면 그 날로 끝난다 — 다음 주로 넘치지 않는다', () => {
    expect(bucketEndMs('W', kstMidnight(2026, 8, 23) + 3_600_000, FAR_FUTURE))
      .toBe(kstDayLast(2026, 8, 23));
  });

  it('월봉은 그 달 마지막 날까지', () => {
    expect(bucketEndMs('M', kstMidnight(2026, 8, 3) + 9 * 3_600_000, FAR_FUTURE))
      .toBe(kstDayLast(2026, 8, 31));
  });

  it('12월은 다음 해 1월로 넘어간다 — 월 롤오버', () => {
    expect(bucketEndMs('M', kstMidnight(2025, 12, 15), FAR_FUTURE))
      .toBe(kstDayLast(2025, 12, 31));
  });

  // 진행 중인 칸은 상한이 아직 미래다. 미래를 상한으로 주면 그 칸의 「마지막 봉」이
  // 존재하지 않는 시각을 가리킨다 — `nowMs` 로 잘라 라이브 엣지가 되게 한다.
  it('진행 중인 칸은 지금으로 자른다', () => {
    const now = kstMidnight(2026, 8, 20) + 5 * 3_600_000; // 목요일 05:00 KST
    expect(bucketEndMs('W', kstMidnight(2026, 8, 18) + 9 * 3_600_000, now)).toBe(now);
    expect(bucketEndMs('M', kstMidnight(2026, 8, 3) + 9 * 3_600_000, now)).toBe(now);
  });
});

describe('jumpPublicationRange', () => {
  const FAR_FUTURE = kstMidnight(2030, 1, 1);
  const TUE = kstMidnight(2026, 8, 18) + 9 * 3_600_000;

  it('칸 시작과 상한을 함께 낸다 — 소비 창이 둘을 다른 일에 쓴다', () => {
    expect(jumpPublicationRange([{ ts_ms: TUE }], TUE, 'W', FAR_FUTURE))
      .toEqual({ fromMs: TUE, toMs: kstDayLast(2026, 8, 23) });
  });

  it('캔들이 없으면 null', () => {
    expect(jumpPublicationRange([], TUE, 'W', FAR_FUTURE)).toBeNull();
  });
});
