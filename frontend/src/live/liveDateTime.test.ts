import { describe, it, expect } from 'vitest';
import {
  nextHistoricalFrom,
  nextCoverageFrom,
  realMsToYyyymmdd,
  subtractDaysKst,
  subtractWeekdaysKst,
  earliestAllowedMinuteDate,
  PAST_CANDLES_MAX_DAYS,
  STEP_CANDLE_TARGET,
  stepTradingDays,
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
  // 2026-02-02(월) 09:00 KST in Unix ms — axis earliest for the base cases.
  const axisEarliestMs = Date.UTC(2026, 1, 2, 0, 0, 0);
  const axisEarliestDate = realMsToYyyymmdd(axisEarliestMs);

  it('steps back one step from the axis earliest when no fetch is in flight', () => {
    const got = nextHistoricalFrom(axisEarliestMs, null, '1m');
    // 1m 스텝 = 1거래일, 월요일 base → 주말 스킵 → 직전 금요일.
    expect(got).toBe('20260130');
    expect(got).toBe(subtractWeekdaysKst(axisEarliestDate, stepTradingDays('1m')));
  });

  it('bases off historicalFromDate when it is already earlier than the axis (holiday-span progress)', () => {
    const earlier = subtractDaysKst(axisEarliestDate, 40);
    const got = nextHistoricalFrom(axisEarliestMs, earlier, '1m');
    expect(got).toBe(subtractWeekdaysKst(earlier, stepTradingDays('1m')));
  });

  it('ignores a historicalFromDate that is NOT earlier than the axis earliest', () => {
    const later = subtractDaysKst(axisEarliestDate, -5);
    const got = nextHistoricalFrom(axisEarliestMs, later, '1m');
    expect(got).toBe(subtractWeekdaysKst(axisEarliestDate, stepTradingDays('1m')));
  });

  it('honors the timeframe (coarser tf → bigger step; D uses calendar days)', () => {
    const m1 = nextHistoricalFrom(axisEarliestMs, null, '1m');
    const m30 = nextHistoricalFrom(axisEarliestMs, null, '30m');
    const daily = nextHistoricalFrom(axisEarliestMs, null, 'D');
    expect(m30).toBe(subtractWeekdaysKst(axisEarliestDate, stepTradingDays('30m')));
    expect(daily).toBe(subtractDaysKst(axisEarliestDate, stepChunkDays('D')));
    expect(m30 < m1).toBe(true);
    expect(daily < m30).toBe(true);
  });

  it('is monotonic: feeding its own output back always steps further back', () => {
    const first = nextHistoricalFrom(axisEarliestMs, null, '1m');
    const second = nextHistoricalFrom(axisEarliestMs, first, '1m');
    expect(second < first).toBe(true);
  });
});

describe('nextCoverageFrom', () => {
  // Coverage-gap 백필(A안) 커널: axis earliest가 아니라 요청 창(historicalFromDate,
  // 없으면 rangeWindowFromDate)을 base로 한 스텝만 걷는다 — 복원된 캔들로 axis가
  // 수개월 과거여도 한 스텝이 폭발하지 않게 한다.
  it('bases off rangeWindowFromDate when no extension yet (historicalFromDate null)', () => {
    // '20260601'은 월요일 → 1m 1거래일 스텝 → 직전 금요일 '20260529'.
    const got = nextCoverageFrom(null, '20260601', '1m');
    expect(got).toBe('20260529');
  });

  it('bases off historicalFromDate once an extension is in flight (ignores window)', () => {
    const got = nextCoverageFrom('20260520', '20260601', '1m');
    expect(got).toBe(subtractWeekdaysKst('20260520', 1)); // '20260519' (수→화)
  });

  it('does NOT use an axis earliest — result is window-relative, not months-deep', () => {
    // 캔들이 몇 달치 복원돼도(=axis가 과거여도) coverage 스텝은 창 기준 한 스텝만 뒤로.
    const got = nextCoverageFrom(null, '20260601', '30m');
    expect(got > '20260501').toBe(true); // 한 달치 폭발 아님
  });

  it('is monotonic: feeding its own output back always steps further back', () => {
    const first = nextCoverageFrom('20260520', '20260601', '1m');
    const second = nextCoverageFrom(first, '20260601', '1m');
    expect(second < first).toBe(true);
  });
});

describe('step sizing — 캔들 50개 통일 (STEP_CANDLE_TARGET)', () => {
  it('target is 50 candles for every timeframe', () => {
    expect(STEP_CANDLE_TARGET).toBe(50);
  });

  it('minute steps convert 50 candles to trading days (min 1 — date-granular API)', () => {
    // ceil(50 × 봉분 ÷ 390): 1m~5m은 1일 floor, 10m/15m=2, 30m=4.
    expect(stepTradingDays('1m')).toBe(1);
    expect(stepTradingDays('3m')).toBe(1);
    expect(stepTradingDays('5m')).toBe(1);
    expect(stepTradingDays('10m')).toBe(2);
    expect(stepTradingDays('15m')).toBe(2);
    expect(stepTradingDays('30m')).toBe(4);
  });

  it('D/W/M steps convert 50 candles to calendar days', () => {
    expect(stepChunkDays('D')).toBe(70); // ceil(50 ÷ (5/7))
    expect(stepChunkDays('W')).toBe(350); // 50 × 7
    expect(stepChunkDays('M')).toBe(1550); // 50 × 31
  });
});

describe('subtractWeekdaysKst', () => {
  // 2026-05-18은 월요일(아래 isKrxRegularSessionNow 픽스처와 동일 근거).
  it('skips a weekend: Monday − 1 weekday = previous Friday', () => {
    expect(subtractWeekdaysKst('20260518', 1)).toBe('20260515');
  });

  it('counts only weekdays: Monday − 5 weekdays = previous Monday', () => {
    expect(subtractWeekdaysKst('20260518', 5)).toBe('20260511');
  });

  it('weekend base walks back to the nearest prior weekday and beyond', () => {
    expect(subtractWeekdaysKst('20260517', 1)).toBe('20260515'); // 일 → 금
    expect(subtractWeekdaysKst('20260516', 1)).toBe('20260515'); // 토 → 금
  });

  it('never lands on a weekend and is always strictly earlier (monotonic)', () => {
    for (let offset = 0; offset < 14; offset += 1) {
      const base = subtractDaysKst('20260518', offset);
      for (const n of [1, 2, 8]) {
        const got = subtractWeekdaysKst(base, n);
        expect(got < base).toBe(true);
        const y = parseInt(got.slice(0, 4), 10);
        const m = parseInt(got.slice(4, 6), 10);
        const d = parseInt(got.slice(6, 8), 10);
        const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        expect(wd).not.toBe(0);
        expect(wd).not.toBe(6);
      }
    }
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
  const axisEarliestMs = Date.UTC(2026, 4, 26, 0, 0, 0); // '20260526'(화) 09:00 KST
  const base = {
    historicalFromDate: '20260521' as string | null, // 목요일
    axisEarliestMs,
    earliestAllowedDate: '20251010', // far floor → not clamped
    timeframe: '1m' as const, // 1거래일 스텝
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
      nextFrom: subtractWeekdaysKst('20260521', 1), // '20260520' (목→수)
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

  // Coverage-gap 경로(A안): whitespace는 찼지만(visibleFrom ≥ 0) 지표 커버리지가
  // viewport 좌단보다 뒤(더 최근)면 window-base로 range 창만 확장한다.
  describe('coverage-gap path', () => {
    const cov = {
      ...base,
      visibleFrom: 3, // whitespace 없음
      historicalFromDate: null as string | null,
      rangeWindowFromDate: '20260521',
    };

    it('fetches a window-base step when viewport left is older than coverage', () => {
      expect(
        planFillStep({ ...cov, viewportLeftDate: '20260410', coverageFromDate: '20260519' }),
      ).toEqual({ action: 'fetch', nextFrom: subtractWeekdaysKst('20260521', 1) });
    });

    it('stops when coverage already reaches the viewport left edge', () => {
      expect(
        planFillStep({ ...cov, viewportLeftDate: '20260519', coverageFromDate: '20260519' }),
      ).toEqual({ action: 'stop' });
    });

    it('stops when coverage extends past (older than) the viewport left edge', () => {
      expect(
        planFillStep({ ...cov, viewportLeftDate: '20260519', coverageFromDate: '20260410' }),
      ).toEqual({ action: 'stop' });
    });

    it('is inert when coverage args are absent (D/W/M or no range indicators)', () => {
      // 신규 인자를 생략하면 기존 whitespace-only 동작 그대로 → stop.
      expect(planFillStep({ ...base, visibleFrom: 3 })).toEqual({ action: 'stop' });
    });

    it('whitespace path wins when BOTH whitespace and coverage-gap apply (axis-base)', () => {
      // visibleFrom < 0이면 coverage 인자가 있어도 axis-base nextHistoricalFrom.
      expect(
        planFillStep({
          ...cov,
          visibleFrom: -50,
          historicalFromDate: '20260521',
          viewportLeftDate: '20260410',
          coverageFromDate: '20260519',
        }),
      ).toEqual({ action: 'fetch', nextFrom: subtractWeekdaysKst('20260521', 1) });
    });

    it('coverage-gap still honors the clamp floor', () => {
      expect(
        planFillStep({
          ...cov,
          historicalFromDate: '20251010', // at/below earliestAllowedDate
          viewportLeftDate: '20260410',
          coverageFromDate: '20260519',
        }),
      ).toEqual({ action: 'stop' });
    });
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
