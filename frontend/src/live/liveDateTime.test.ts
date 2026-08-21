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
  planViewportContraction,
  CONTRACT_RETAIN_STEPS,
  CONTRACT_TRIGGER_STEPS,
} from './liveDateTime';
import { PAST_CHUNK_CALENDAR_DAYS, pastChunkCalendarDays } from '../api/livePastCandles';
import { MINUTE_TIMEFRAMES, fetchBucketMsFor } from '../state/livePage';
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
    // 분봉 스텝은 tf 비례(5×m 거래일, ADR-0105 개정) — 30m(150) > D(50) > 1m(5).
    expect(m30).toBe(subtractWeekdaysKst(axisEarliestDate, STEP_TRADING_DAYS['30m']));
    expect(m30 < m1).toBe(true);
    expect(daily).toBe(subtractWeekdaysKst(axisEarliestDate, STEP_TRADING_DAYS['D']));
    expect(m30 < daily).toBe(true);
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
    // 캔들이 몇 달치 복원돼도(=axis가 과거여도) coverage 스텝은 창 기준 **한 스텝**만
    // 뒤로. 1m 스텝(5거래일) 기준으로 단언한다 — 30m 은 스텝 자체가 150거래일이라
    // (ADR-0105 개정) "한 달 폭발 아님" 단언의 리트머스로 못 쓴다.
    const got = nextCoverageFrom(null, '20260601', '1m');
    expect(got > '20260501').toBe(true); // 한 달치 폭발 아님
    // 30m 도 여전히 정확히 한 스텝이다(폭이 넓을 뿐 axis 기준 폭발이 아님).
    expect(nextCoverageFrom(null, '20260601', '30m')).toBe(
      subtractWeekdaysKst('20260601', STEP_TRADING_DAYS['30m']),
    );
  });

  it('is monotonic: feeding its own output back always steps further back', () => {
    const first = nextCoverageFrom('20260520', '20260601', '1m');
    const second = nextCoverageFrom(first, '20260601', '1m');
    expect(second < first).toBe(true);
  });
});

describe('step sizing — STEP_TRADING_DAYS 단일 테이블 (ADR-0105, 2026-08-05 개정)', () => {
  it('분봉은 5거래일 × tf분 — 스텝당 벤더 페이지 수가 전 tf 균일해진다', () => {
    // #1091 이후 벤더 페이지 커버리지가 tf 에 비례하므로 스텝도 비례해야
    // 넓은 tf 딥팬의 왕복 수가 tf 배수로 준다. 1m 은 종전 값 그대로(회귀 없음).
    expect(STEP_TRADING_DAYS['1m']).toBe(5);
    expect(STEP_TRADING_DAYS['3m']).toBe(15);
    expect(STEP_TRADING_DAYS['5m']).toBe(25);
    expect(STEP_TRADING_DAYS['10m']).toBe(50);
    expect(STEP_TRADING_DAYS['15m']).toBe(75);
    expect(STEP_TRADING_DAYS['30m']).toBe(150);
  });

  it('3-상수 불변식이 전 분봉 tf 에서 성립한다 (스텝×2 ≤ 청크, ≤ 백엔드 예산)', () => {
    // 셋 중 하나만 바뀌면 조용히 깨지는 사슬 — 여기서 tf 마다 핀으로 박는다.
    // 백엔드 예산(12×m, live_candle_backfill._fresh_budget_for)은 이 파일에서
    // import 할 수 없으므로 같은 식으로 재계산해 대조한다.
    //
    // ⚠ m 은 **fetch 분**이다(표시 분이 아니다). 세 상수가 함께 스케일되는 기준은
    // 벤더에 요청하는 주기이고, 120·240 은 30m 로 받는다(`fetchBucketMsFor`). 표시
    // 분으로 재면 이 불변식은 그 두 tf 에서 의미가 없다 — 재는 대상이 아니다.
    for (const tf of MINUTE_TIMEFRAMES) {
      const m = fetchBucketMsFor(tf) / 60_000;
      const stepTradingDays = STEP_TRADING_DAYS[tf];
      expect(stepTradingDays).toBe(5 * m);
      const dispatchTradingDays = stepTradingDays * MAX_BATCH_STEPS_PER_DISPATCH;
      // 거래일 → 캘린더일 상한: ×7/5 (주말 스킵의 최악 폭).
      const dispatchCalendarDays = Math.ceil(dispatchTradingDays * (7 / 5));
      expect(dispatchCalendarDays).toBeLessThanOrEqual(pastChunkCalendarDays(m * 60_000));
      const backendFreshBudget = 12 * m;
      expect(dispatchTradingDays).toBeLessThanOrEqual(backendFreshBudget);
    }
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
  it('스텝당 봉 수는 분봉 전 tf 에서 1,950봉 균일 (스텝 tf 비례의 귀결)', () => {
    // 스텝 = 5m 거래일, 봉/거래일 = 390/m → 곱하면 m 이 약분되어 1,950. 이 균일성이
    // 곧 "스텝당 벤더 페이지 ~2.2개 균일"이다. D/W/M은 STEP_CANDLE_TARGET(50)봉.
    expect(stepCandlesEstimate('1m')).toBe(1950);
    expect(stepCandlesEstimate('5m')).toBe(1950); // 25거래일 × 78봉
    expect(stepCandlesEstimate('15m')).toBe(1950); // 75거래일 × 26봉
    expect(stepCandlesEstimate('30m')).toBe(1950); // 150거래일 × 13봉
    expect(stepCandlesEstimate('D')).toBe(50);
  });

  it('예산 = ceil(빈공간 바 수 ÷ 스텝당 봉 수), 최소 1', () => {
    expect(fillBudgetSteps(50, '1m')).toBe(1); // 1,950봉 스텝 1개로 충분
    expect(fillBudgetSteps(3000, '1m')).toBe(2); // ceil(3000/1950)
    expect(fillBudgetSteps(350, '30m')).toBe(1); // 스텝이 1,950봉이라 1개로 충분
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
  it('분봉 초기 캘린더창은 봉 크기와 무관하게 5거래일 수준이다', () => {
    // useLiveBundle.seedFrom = today − initialHistoricalDaysFor(tf). 봉 크기와
    // 무관하게 5거래일이므로 7캘린더일. 과거(40일)에서 대폭 축소.
    //
    // 60m 만 8이다 — 정규장 390분을 60이 나누지 못해(6.5봉/일) 봉 개수 반올림이
    // 32.5 → 33 으로 올라가고, 33봉은 5.08거래일이라 7일에 안 들어간다. 봉 크기에
    // **비례해** 커지는 것이 아니라 경계에서 하루가 붙는 것이므로 의도대로다.
    for (const tf of MINUTE_TIMEFRAMES) {
      expect(initialHistoricalDaysFor(tf)).toBe(tf === '60m' ? 8 : 7);
    }
  });
  it('D는 기존 1년(350캘린더일) 유지', () => {
    expect(initialHistoricalDaysFor('D')).toBe(350);
  });
});

describe('planViewportContraction — 좌측 팬 창을 앞으로 당긴다', () => {
  const TF = '1m' as const;
  const LEFT = '20260814';   // 뷰포트 좌단 날짜

  it('창이 없으면(초기 상태) 자르지 않는다', () => {
    expect(planViewportContraction(null, LEFT, TF)).toBeNull();
  });

  it('발동 임계 안이면 자르지 않는다', () => {
    // 좌단에서 1스텝만 과거 — 아직 회수할 값이 없다.
    const near = planViewportContraction('20260813', LEFT, TF);
    expect(near).toBeNull();
  });

  it('임계를 넘으면 **뷰포트 좌단보다 과거**로 당긴다 — 재요청을 유발하지 않는다', () => {
    // 막는 방향: 좌단(또는 그보다 미래)까지 잘라 `planCoverageGapFill` 의 재요청 조건
    // (좌단 < coverageFrom)에 곧바로 걸리는 회귀 — 자르고 즉시 되받는 진동이다
    // (#582 wide-range 사고와 같은 모양).
    const next = planViewportContraction('20260101', LEFT, TF);
    expect(next).not.toBeNull();
    expect(next! < LEFT).toBe(true);       // 좌단보다 과거 = 갭 없음
    expect(next! > '20260101').toBe(true); // 실제로 앞으로 당겨졌다
  });

  it('한 번 당기면 **수렴한다** — 같은 뷰포트에서 두 번째는 no-op', () => {
    // 이것이 진동 방지의 핵심 성질이다. 두 임계가 붙어 있으면(RETAIN == TRIGGER)
    // 당긴 결과가 다시 임계를 넘어 매 이벤트마다 당기고 되받는다.
    const first = planViewportContraction('20260101', LEFT, TF);
    expect(first).not.toBeNull();
    expect(planViewportContraction(first, LEFT, TF)).toBeNull();
  });

  it('두 임계 사이에 간격이 있다 — 간격이 0이면 위 수렴이 성립하지 않는다', () => {
    expect(CONTRACT_RETAIN_STEPS).toBeLessThan(CONTRACT_TRIGGER_STEPS);
  });

  it('**한 달 창(4스텝 ≈ 20거래일)이 잡힌다** — 이 변경의 목적', () => {
    // 2026-08-16 성능 감사가 실측한 아픈 케이스가 "028050 한 달 창 콜드 11.7초" 였다.
    // 임계 6스텝(=30거래일) 시절엔 한 달(21거래일)이 그 아래라 **영영 안 잡혔다** —
    // contract 가 발동조차 안 하니 로그로도 안 보였다. 임계를 되돌리면 여기서 실패한다.
    //
    // 스텝 산술은 `nextCoverageFrom`(1스텝 뒤로)을 재사용한다 — `stepBackFrom` 은
    // 모듈 지역이고, 테스트가 자기 날짜 계산을 따로 쓰면 그게 또 다른 진실이 된다.
    let monthAgo = LEFT;
    for (let i = 0; i < 4; i += 1) monthAgo = nextCoverageFrom(null, monthAgo, TF);
    expect(planViewportContraction(monthAgo, LEFT, TF)).not.toBeNull();
  });

  it('**D/W/M 에서는 절대 자르지 않는다** — 일봉 캔들이 눈앞에서 사라지는 회귀', () => {
    // 2026-08-21 사용자 관측: 일봉에서 줌아웃(과거 로드)→줌인→줌아웃 시 과거
    // 캔들이 사라졌다 재로드됐다. D/W/M 은 range 지표가 없어(coverage null) 축소
    // 분기가 항상 열리는데, `historicalFromDate` 가 일봉에선 **캔들 창 자체**라
    // 축소 = 화면에서 데이터 소멸이다. 이 장치의 존재 이유(sidecar 29MB)는 분봉
    // 전용이므로 D/W/M 은 어떤 창 폭에서도 no-op 이어야 한다.
    for (const tf of ['D', 'W', 'M'] as const) {
      expect(planViewportContraction('20200101', LEFT, tf)).toBeNull();
    }
  });

  it('화면에 **떠 있는** 구간은 안 자른다 — 줌아웃 케이스', () => {
    // 창이 넓은 이유가 "그만큼을 실제로 보고 있어서" 라면 자르면 안 된다.
    // 뷰포트 좌단이 곧 창 시작이면 임계 안이므로 no-op 이어야 한다.
    let monthAgo = LEFT;
    for (let i = 0; i < 4; i += 1) monthAgo = nextCoverageFrom(null, monthAgo, TF);
    expect(planViewportContraction(monthAgo, monthAgo, TF)).toBeNull();
  });
});

