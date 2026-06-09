import { describe, it, expect } from 'vitest';
import {
  nextHistoricalFrom,
  realMsToYyyymmdd,
  subtractDaysKst,
  earliestAllowedMinuteDate,
  PAST_CANDLES_MAX_DAYS,
  stepChunkDays,
  planFillStep,
  isKrxRegularSessionNow,
  initialCandleTargetFor,
  initialHistoricalDaysFor,
} from './liveDateTime';
import { unixMsToKSTDate } from '../util/time';

/** SR-1/SR-3: the /live infinite-scroll backfill policy was fused inside
 * LiveChartRoot's subscribeVisibleLogicalRangeChange effect, testable only by
 * driving a chart mock. nextHistoricalFrom is the extracted pure kernel:
 * "given where the axis currently starts, what date should the next leftward
 * chunk fetch back to?" These cases pin the holiday-span / monotonic-decrease
 * rule directly. */
describe('nextHistoricalFrom', () => {
  // 2026-02-02 09:00 KST in Unix ms — axis earliest for the base cases.
  const axisEarliestMs = Date.UTC(2026, 1, 2, 0, 0, 0);
  const axisEarliestDate = realMsToYyyymmdd(axisEarliestMs);

  it('steps back chunkDays from the axis earliest when no fetch is in flight', () => {
    const got = nextHistoricalFrom(axisEarliestMs, null, 5);
    expect(got).toBe(subtractDaysKst(axisEarliestDate, 5));
  });

  it('bases off historicalFromDate when it is already earlier than the axis (holiday-span progress)', () => {
    const earlier = subtractDaysKst(axisEarliestDate, 40);
    const got = nextHistoricalFrom(axisEarliestMs, earlier, 5);
    expect(got).toBe(subtractDaysKst(earlier, 5));
  });

  it('ignores a historicalFromDate that is NOT earlier than the axis earliest', () => {
    const later = subtractDaysKst(axisEarliestDate, -5);
    const got = nextHistoricalFrom(axisEarliestMs, later, 5);
    expect(got).toBe(subtractDaysKst(axisEarliestDate, 5));
  });

  it('honors the injected chunkDays (different chunkDays → different result)', () => {
    const small = nextHistoricalFrom(axisEarliestMs, null, 5);
    const large = nextHistoricalFrom(axisEarliestMs, null, 350);
    expect(small).toBe(subtractDaysKst(axisEarliestDate, 5));
    expect(large).toBe(subtractDaysKst(axisEarliestDate, 350));
    expect(small).not.toBe(large);
  });

  it('is monotonic: feeding its own output back always steps further back', () => {
    const first = nextHistoricalFrom(axisEarliestMs, null, 5);
    const second = nextHistoricalFrom(axisEarliestMs, first, 5);
    expect(second < first).toBe(true);
  });
});

describe('stepChunkDays', () => {
  it('minute timeframes are a fixed 3-trading-day step (≈5 calendar days)', () => {
    // 3 trading days / (5/7 trading-days-per-calendar-day) = ceil(4.2) = 5.
    for (const tf of ['1m', '3m', '5m', '10m', '15m', '30m'] as const) {
      expect(stepChunkDays(tf)).toBe(5);
    }
  });

  it('D keeps the prior one-shot 350-calendar-day window (≈250 daily candles)', () => {
    expect(stepChunkDays('D')).toBe(350);
  });

  it('W/M keep the prior one-shot windows (120 candles)', () => {
    expect(stepChunkDays('W')).toBe(840); // 120 × 7
    expect(stepChunkDays('M')).toBe(3720); // 120 × 31
  });
});

describe('earliestAllowedMinuteDate', () => {
  it('is today minus (PAST_CANDLES_MAX_DAYS - 1) calendar days', () => {
    expect(PAST_CANDLES_MAX_DAYS).toBe(250);
    expect(earliestAllowedMinuteDate('20260527')).toBe(
      subtractDaysKst('20260527', PAST_CANDLES_MAX_DAYS - 1),
    );
  });

  it('uses 249 (inclusive 250-day window), not 250', () => {
    // 250-day window inclusive of today → floor is today-249.
    expect(earliestAllowedMinuteDate('20260527')).not.toBe(
      subtractDaysKst('20260527', 250),
    );
  });
});

describe('realMsToYyyymmdd', () => {
  // Single-source invariant (fe-shared-02): realMsToYyyymmdd is a /live-local
  // alias that delegates to util/time::unixMsToKSTDate — the one owner of the
  // "Unix-ms → YYYYMMDD KST" calendar-day rule. These pin the boundary (which
  // had no direct coverage) and lock the delegation so a future edit can't
  // quietly reintroduce a divergent +9h copy.
  it('returns the KST calendar day at session open (09:00 KST = 00:00 UTC)', () => {
    expect(realMsToYyyymmdd(Date.UTC(2026, 4, 20, 0, 0, 0))).toBe('20260520');
  });

  it('uses the KST calendar boundary (UTC 15:00 of day N-1 = KST 00:00 of day N)', () => {
    const kstMidnight = Date.UTC(2026, 4, 19, 15, 0, 0);
    expect(realMsToYyyymmdd(kstMidnight - 1)).toBe('20260519');
    expect(realMsToYyyymmdd(kstMidnight)).toBe('20260520');
  });

  it('agrees with the single source unixMsToKSTDate across 48h of samples', () => {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let h = 0; h < 48; h += 1) {
      const ms = base + h * 3_600_000;
      expect(realMsToYyyymmdd(ms)).toBe(unixMsToKSTDate(ms));
    }
  });
});

describe('planFillStep', () => {
  const axisEarliestMs = Date.UTC(2026, 4, 26, 0, 0, 0); // '20260526' 09:00 KST
  const base = {
    historicalFromDate: '20260521' as string | null,
    axisEarliestMs,
    earliestAllowedDate: '20251010', // far floor → not clamped
    stepCalendarDays: 5,
    stepCount: 1,
    maxSteps: 60,
  };

  it('stops when the viewport is full (visibleFrom >= 0)', () => {
    expect(planFillStep({ ...base, visibleFrom: 3 })).toEqual({ action: 'stop' });
  });

  it('stops when the viewport range is unavailable (visibleFrom null)', () => {
    expect(planFillStep({ ...base, visibleFrom: null })).toEqual({ action: 'stop' });
  });

  it('fetches the next step back when whitespace remains', () => {
    expect(planFillStep({ ...base, visibleFrom: -50 })).toEqual({
      action: 'fetch',
      nextFrom: subtractDaysKst('20260521', 5), // '20260516'
    });
  });

  it('stops at the 250-day clamp floor (already at/below earliestAllowed)', () => {
    expect(
      planFillStep({ ...base, visibleFrom: -50, historicalFromDate: '20251010' }),
    ).toEqual({ action: 'stop' });
  });

  it('stops at the backstop (stepCount reached maxSteps) to bound the loop', () => {
    expect(
      planFillStep({ ...base, visibleFrom: -50, stepCount: 60 }),
    ).toEqual({ action: 'stop' });
  });
});

// 2026-05-18은 월요일. 09:00 KST = 2026-05-18 00:00 UTC = 1_779_062_400_000.
const MON_OPEN_MS = 1_779_062_400_000;
const HOUR = 3_600_000;

describe('isKrxRegularSessionNow', () => {
  it('true during weekday regular session (10:00 KST Mon)', () => {
    expect(isKrxRegularSessionNow(MON_OPEN_MS + 1 * HOUR)).toBe(true);
  });
  it('true at exact open and close boundaries', () => {
    expect(isKrxRegularSessionNow(MON_OPEN_MS)).toBe(true);
    expect(isKrxRegularSessionNow(MON_OPEN_MS + 6.5 * HOUR)).toBe(true);
  });
  it('false after close (18:00 KST Mon)', () => {
    expect(isKrxRegularSessionNow(MON_OPEN_MS + 9 * HOUR)).toBe(false);
  });
  it('false before open (08:00 KST Mon)', () => {
    expect(isKrxRegularSessionNow(MON_OPEN_MS - 1 * HOUR)).toBe(false);
  });
  it('false on weekend (Sat 10:00 KST)', () => {
    const SAT_OPEN_MS = MON_OPEN_MS + 5 * 24 * HOUR; // +5 days → Saturday
    expect(isKrxRegularSessionNow(SAT_OPEN_MS + 1 * HOUR)).toBe(false);
  });
});

// (a) /diagnose 2026-06-09 후속: 초기 분봉 fetch 창을 5거래일로 축소(첫 그림 속도).
// 화면 초기 뷰포트는 ~300바만 보이고 나머지는 lazy-fetch가 채우므로, 콜드로드마다
// 40일치(~115 KIS 호출)를 받던 것을 5거래일치(~20 호출)로 줄인다.
describe('initialCandleTargetFor — 초기 분봉 창 (5거래일)', () => {
  it('1m: 5거래일 = 1,950봉 (= 5 × 390분/일)', () => {
    expect(initialCandleTargetFor('1m')).toBe(1950);
  });
  it('봉 크기에 비례 축소: 3m=650, 5m=390, 10m=195, 15m=130, 30m=65', () => {
    expect(initialCandleTargetFor('3m')).toBe(650);
    expect(initialCandleTargetFor('5m')).toBe(390);
    expect(initialCandleTargetFor('10m')).toBe(195);
    expect(initialCandleTargetFor('15m')).toBe(130);
    expect(initialCandleTargetFor('30m')).toBe(65);
  });
  it('D/W/M은 불변(250봉)', () => {
    expect(initialCandleTargetFor('D')).toBe(250);
    expect(initialCandleTargetFor('W')).toBe(250);
    expect(initialCandleTargetFor('M')).toBe(250);
  });
  it('모든 분봉 TF의 초기 캘린더창 = 7일 (5거래일을 5/7 밀도로 환산)', () => {
    // useLiveBundle.seedFrom = today − initialHistoricalDaysFor(tf). 봉 크기와
    // 무관하게 5거래일이므로 전부 7캘린더일. 과거(40일)에서 대폭 축소.
    for (const tf of ['1m', '3m', '5m', '10m', '15m', '30m'] as const) {
      expect(initialHistoricalDaysFor(tf)).toBe(7);
    }
  });
  it('D는 기존 1년(350캘린더일) 유지', () => {
    expect(initialHistoricalDaysFor('D')).toBe(350);
  });
});
