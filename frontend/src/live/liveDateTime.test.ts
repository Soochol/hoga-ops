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
  STEP_TRADING_DAYS,
  stepCandlesEstimate,
  fillBudgetSteps,
  dispatchStepsFor,
  MAX_BATCH_STEPS_PER_DISPATCH,
  planFillStep,
  isKrxRegularSessionNow,
  initialCandleTargetFor,
  initialHistoricalDaysFor,
} from './liveDateTime';
import { PAST_CHUNK_CALENDAR_DAYS } from '../api/livePastCandles';
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
    // 1m 스텝 = 5거래일, 월요일(20260202) base → 주말 스킵 → 직전 월요일 20260126.
    expect(got).toBe('20260126');
    expect(got).toBe(subtractWeekdaysKst(axisEarliestDate, STEP_TRADING_DAYS['1m']));
  });

  it('bases off historicalFromDate when it is already earlier than the axis (holiday-span progress)', () => {
    const earlier = subtractDaysKst(axisEarliestDate, 40);
    const got = nextHistoricalFrom(axisEarliestMs, earlier, '1m');
    expect(got).toBe(subtractWeekdaysKst(earlier, STEP_TRADING_DAYS['1m']));
  });

  it('ignores a historicalFromDate that is NOT earlier than the axis earliest', () => {
    const later = subtractDaysKst(axisEarliestDate, -5);
    const got = nextHistoricalFrom(axisEarliestMs, later, '1m');
    expect(got).toBe(subtractWeekdaysKst(axisEarliestDate, STEP_TRADING_DAYS['1m']));
  });

  it('honors the timeframe (coarser tf → bigger step; all weekend-skipped)', () => {
    const m1 = nextHistoricalFrom(axisEarliestMs, null, '1m');
    const m30 = nextHistoricalFrom(axisEarliestMs, null, '30m');
    const daily = nextHistoricalFrom(axisEarliestMs, null, 'D');
    // 분봉은 전부 5거래일이라 1m·30m 스텝 크기가 같다(단일 통화).
    expect(m30).toBe(subtractWeekdaysKst(axisEarliestDate, STEP_TRADING_DAYS['30m']));
    expect(m30).toBe(m1);
    expect(daily).toBe(subtractWeekdaysKst(axisEarliestDate, STEP_TRADING_DAYS['D']));
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
    // '20260601'은 월요일 → 1m 5거래일 스텝 → 직전 월요일 '20260525'.
    const got = nextCoverageFrom(null, '20260601', '1m');
    expect(got).toBe('20260525');
  });

  it('bases off historicalFromDate once an extension is in flight (ignores window)', () => {
    const got = nextCoverageFrom('20260520', '20260601', '1m');
    expect(got).toBe(subtractWeekdaysKst('20260520', STEP_TRADING_DAYS['1m'])); // '20260513' (수)
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

describe('step sizing — STEP_TRADING_DAYS 단일 테이블 (ADR-0105)', () => {
  it('분봉은 전 타임프레임 5거래일로 균일 (백엔드 날짜-병렬 배치 1회)', () => {
    expect(STEP_TRADING_DAYS['1m']).toBe(5);
    expect(STEP_TRADING_DAYS['3m']).toBe(5);
    expect(STEP_TRADING_DAYS['5m']).toBe(5);
    expect(STEP_TRADING_DAYS['10m']).toBe(5);
    expect(STEP_TRADING_DAYS['15m']).toBe(5);
    expect(STEP_TRADING_DAYS['30m']).toBe(5);
  });

  it('D/W/M은 캔들 STEP_CANDLE_TARGET(50)개에서 유도된 거래일', () => {
    expect(STEP_CANDLE_TARGET).toBe(50);
    expect(STEP_TRADING_DAYS['D']).toBe(50); // 일봉 50개 = 50거래일
    expect(STEP_TRADING_DAYS['W']).toBe(250); // 주봉 50개 = 50주 × 5거래일
    expect(STEP_TRADING_DAYS['M']).toBe(1050); // 월봉 50개 = 50개월 × 21거래일
  });

  it('D/W 거래일 스텝은 기존 캘린더일 스텝과 동치 (회귀 없음 증명)', () => {
    // 주말 스킵이 D/W를 정확히 기존 캘린더일 폭으로 되돌린다.
    expect(subtractWeekdaysKst('20260202', STEP_TRADING_DAYS['D'])).toBe(
      subtractDaysKst('20260202', 70), // 기존 stepChunkDays('D')
    );
    expect(subtractWeekdaysKst('20260202', STEP_TRADING_DAYS['W'])).toBe(
      subtractDaysKst('20260202', 350), // 기존 stepChunkDays('W')
    );
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

describe('fillBudgetSteps / stepCandlesEstimate — 제스처 예산 산정', () => {
  it('스텝당 봉 수는 5거래일 폭을 반영한다 (STEP_TRADING_DAYS × 봉/거래일)', () => {
    // 1m: 5거래일 × 390 = 1,950봉/스텝. D/W/M은 STEP_CANDLE_TARGET(50)봉.
    expect(stepCandlesEstimate('1m')).toBe(1950);
    expect(stepCandlesEstimate('5m')).toBe(390); // 5거래일 × 78봉
    expect(stepCandlesEstimate('15m')).toBe(130); // 5거래일 × 26봉
    expect(stepCandlesEstimate('30m')).toBe(65); // 5거래일 × 13봉
    expect(stepCandlesEstimate('D')).toBe(50);
  });

  it('예산 = ceil(빈공간 바 수 ÷ 스텝당 봉 수), 최소 1', () => {
    expect(fillBudgetSteps(50, '1m')).toBe(1); // 1,950봉 스텝 1개로 충분
    expect(fillBudgetSteps(3000, '1m')).toBe(2); // ceil(3000/1950)
    expect(fillBudgetSteps(350, '30m')).toBe(6); // ceil(350/65)
    expect(fillBudgetSteps(60, 'D')).toBe(2); // ceil(60/50)
    expect(fillBudgetSteps(0, '1m')).toBe(1); // 트리거됐다면 최소 1스텝
  });
});

describe('planFillStep — 제스처 예산 모델', () => {
  // fill 도중 뷰포트를 재측정하지 않는다: 입력에 visibleFrom/viewportLeftDate가
  // 없다는 것 자체가 계약이다. 종료는 예산 소진·클램프·coverage 목표 도달뿐.
  const axisEarliestMs = Date.UTC(2026, 4, 26, 0, 0, 0); // '20260526'(화) 09:00 KST
  const base = {
    kind: 'left_pan' as const,
    historicalFromDate: '20260521' as string | null, // 목요일
    axisEarliestMs,
    earliestAllowedDate: '20251010', // far floor → not clamped
    timeframe: '1m' as const, // 5거래일 스텝
    stepCount: 1,
    budget: 3,
  };

  it('fetches the next step while budget remains, batching up to the cap', () => {
    // budget 3 − stepCount 1 = 남은 2 → 분봉은 2스텝 묶음(ADR-0120).
    expect(planFillStep(base)).toEqual({
      action: 'fetch',
      nextFrom: subtractWeekdaysKst('20260521', STEP_TRADING_DAYS['1m'] * 2), // 10평일
      steps: 2,
    });
  });

  it('never batches past the remaining budget (last step is a single)', () => {
    expect(planFillStep({ ...base, stepCount: 2 })).toEqual({
      action: 'fetch',
      nextFrom: subtractWeekdaysKst('20260521', STEP_TRADING_DAYS['1m']),
      steps: 1,
    });
  });

  it('stops when the budget is exhausted (stepCount >= budget)', () => {
    expect(planFillStep({ ...base, stepCount: 3 })).toEqual({ action: 'stop' });
  });

  it('stops at the 250-day clamp floor (already at/below earliestAllowed)', () => {
    expect(
      planFillStep({ ...base, historicalFromDate: '20251010' }),
    ).toEqual({ action: 'stop' });
  });

  // Coverage-gap fill: 목표(트리거 순간 viewport 좌단, 동결)에 요청 창이 닿을
  // 때까지 window-base로 걷는다.
  describe('coverage-gap fill', () => {
    const cov = {
      ...base,
      kind: 'coverage_gap' as const,
      historicalFromDate: null as string | null,
      rangeWindowFromDate: '20260521',
      coverageTargetDate: '20260410',
      budget: 60, // 날짜 수렴이 주 종료 조건, 예산은 백스톱
    };

    it('fetches a window-base step while the window is behind the frozen target', () => {
      // coverage_gap 은 절대 묶지 않는다(steps=1) — 종료가 날짜 수렴이라 묶으면
      // viewport 가 보지도 않는 과거까지 지표 창이 넓어진다(#582 재발).
      expect(planFillStep(cov)).toEqual({
        action: 'fetch',
        nextFrom: subtractWeekdaysKst('20260521', STEP_TRADING_DAYS['1m']),
        steps: 1,
      });
    });

    it('stops when the window reaches the frozen target', () => {
      expect(
        planFillStep({ ...cov, historicalFromDate: '20260410' }),
      ).toEqual({ action: 'stop' });
    });

    it('stops when the window passes (older than) the frozen target', () => {
      expect(
        planFillStep({ ...cov, historicalFromDate: '20260405' }),
      ).toEqual({ action: 'stop' });
    });

    it('stops when the target/window inputs are absent (defensive)', () => {
      expect(
        planFillStep({ ...cov, coverageTargetDate: null }),
      ).toEqual({ action: 'stop' });
      expect(
        planFillStep({ ...cov, rangeWindowFromDate: null }),
      ).toEqual({ action: 'stop' });
    });

    it('coverage-gap still honors the clamp floor', () => {
      expect(
        planFillStep({ ...cov, historicalFromDate: '20251010' }),
      ).toEqual({ action: 'stop' });
    });

    it('budget backstop applies to coverage fills too', () => {
      expect(planFillStep({ ...cov, stepCount: 60 })).toEqual({ action: 'stop' });
    });
  });
});

describe('배치 dispatch — MAX_BATCH_STEPS_PER_DISPATCH (ADR-0120)', () => {
  it('분봉은 남은 예산이 충분하면 상한까지 묶는다', () => {
    expect(dispatchStepsFor('1m', 10)).toBe(MAX_BATCH_STEPS_PER_DISPATCH);
    expect(dispatchStepsFor('30m', 10)).toBe(MAX_BATCH_STEPS_PER_DISPATCH);
  });

  it('D/W/M은 묶지 않는다 — 한 스텝이 이미 캔들 50개', () => {
    expect(dispatchStepsFor('D', 10)).toBe(1);
    expect(dispatchStepsFor('W', 10)).toBe(1);
    expect(dispatchStepsFor('M', 10)).toBe(1);
  });

  it('남은 예산보다 크게 묶지 않는다', () => {
    expect(dispatchStepsFor('1m', 1)).toBe(1);
    expect(dispatchStepsFor('1m', 0)).toBe(1); // 하한 1(호출 전 예산 가드가 별도)
  });

  // 이 배치 폭은 프론트 청크 캡과 백엔드 신선예산에 동시에 물려 있다. 셋 중 하나가
  // 바뀌면 여기서 깨져야 한다 — 안 그러면 조용히 청크 분할(요청 2개) 또는
  // fetch_budget_exhausted 유예(60s 주기 전진)로 퇴화한다.
  it('배치 폭 ≤ 청크 캡(15캘린더일)이라 요청은 항상 청크 1개', () => {
    const maxWeekdays = STEP_TRADING_DAYS['1m'] * MAX_BATCH_STEPS_PER_DISPATCH;
    const from = subtractWeekdaysKst('20260605', maxWeekdays); // 금요일 기준
    const spanDays =
      (Date.parse('2026-06-05') - Date.parse(
        `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}`,
      )) / 86_400_000;
    expect(spanDays).toBe(14); // 10평일 = 정확히 2주
    expect(spanDays + 1).toBeLessThanOrEqual(PAST_CHUNK_CALENDAR_DAYS);
  });

  it('배치 거래일 수 ≤ 백엔드 max_fresh_dates_per_collect(12)', () => {
    const BACKEND_FRESH_BUDGET = 12; // live_candle_backfill.max_fresh_dates_per_collect
    expect(STEP_TRADING_DAYS['1m'] * MAX_BATCH_STEPS_PER_DISPATCH).toBeLessThanOrEqual(
      BACKEND_FRESH_BUDGET,
    );
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
