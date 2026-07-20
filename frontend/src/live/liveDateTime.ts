/**
 * KST date/time helpers for /live.
 *
 * Holds /live's previous-day arithmetic and default Regular Session bounds.
 * The "Unix-ms → YYYYMMDD KST" calendar-day conversion itself lives once in
 * `util/time::unixMsToKSTDate`; `realMsToYyyymmdd` is a thin /live-local alias.
 * /live components (`LiveChartRoot`, `useLiveBundle`, `LiveStatusBar`) all need
 * "what date is right now in Korea?" — keeping the date math in one place means
 * localising any future Half-Day Session handling here.
 */
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import { TIMEFRAME_TO_MS } from '../api/types';
import { unixMsToKSTDate } from '../util/time';

const TRADING_MINUTES_PER_DAY = 390;        // KRX 09:00–15:30 = 6.5 h
const TRADING_DAYS_PER_CALENDAR_DAYS = 5 / 7;

/** 분봉 scroll-back 깊이 상한 (캘린더일). payload 보호 + lwc setData 비용 한계.
 * useLiveBundle의 클램프와 LiveChartRoot 진행 루프의 종료 판정이 공유한다. */
export const PAST_CANDLES_MAX_DAYS = 250;

/** 250일 클램프 하한 날짜(YYYYMMDD KST). 분봉 fetch는 이 날짜보다 과거로 못 간다.
 * 250일 윈도가 오늘을 포함하므로 오늘 − 249. */
export function earliestAllowedMinuteDate(todayKstYyyymmdd: string): string {
  return subtractDaysKst(todayKstYyyymmdd, PAST_CANDLES_MAX_DAYS - 1);
}

/** Today's YYYYMMDD in KST. */
export function todayKstYyyymmdd(): string {
  return realMsToYyyymmdd(Date.now());
}

/**
 * Convert a real Unix ms timestamp to its YYYYMMDD KST date. Thin /live-local
 * alias for `util/time::unixMsToKSTDate`, the single owner of the calendar-day
 * rule (fe-shared-02); kept so /live code reads in its own vocabulary.
 */
export function realMsToYyyymmdd(realMs: number): string {
  return unixMsToKSTDate(realMs);
}

/** YYYYMMDD KST for the day before `todayYyyymmdd`. */
export function yesterdayKst(todayYyyymmdd: string): string {
  return subtractDaysKst(todayYyyymmdd, 1);
}

/** YYYYMMDD KST for `n` days before `yyyymmdd`. */
export function subtractDaysKst(yyyymmdd: string, n: number): string {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - n);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/** `yyyymmdd`에서 주말(토·일)을 건너뛰며 `n`평일 과거의 YYYYMMDD.
 * 공휴일은 프론트가 모르는 정보(백엔드 KIS 캘린더 소유)라 캘린더상 평일
 * 기준이다 — 공휴일에 떨어진 스텝은 빈 청크로 돌아오고, 진행 루프가 base를
 * 더 과거로 밀어 다음 스텝을 밟는다(`nextHistoricalFrom` base 선택 주석). */
export function subtractWeekdaysKst(yyyymmdd: string, n: number): string {
  let cur = yyyymmdd;
  let remaining = Math.max(1, n);
  while (remaining > 0) {
    cur = subtractDaysKst(cur, 1);
    const wd = kstWeekday(cur);
    if (wd !== 0 && wd !== 6) remaining -= 1;
  }
  return cur;
}

/** Default Regular Session open ms for a YYYYMMDD KST date (09:00 KST = 00:00
 * UTC). KRX Half-Day Session detection is out of scope per spec §2; consumers
 * needing exact bounds should read `live.initial.session_open_ms` instead. */
export function regularSessionOpenMs(yyyymmdd: string): number {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  return Date.UTC(y, m - 1, d, 0, 0, 0);
}

/** Default Regular Session close ms (15:30 KST = open + 6h30m). Same Half-Day
 * Session caveat as `regularSessionOpenMs`. */
export function regularSessionCloseMs(yyyymmdd: string): number {
  return regularSessionOpenMs(yyyymmdd) + 6.5 * 3600 * 1000;
}

/** KST 요일(0=일 … 6=토)을 YYYYMMDD에서 계산. 달력 날짜는 tz 무관이라
 *  Date.UTC 기준 getUTCDay로 안전하게 구한다. */
function kstWeekday(yyyymmdd: string): number {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * True iff `nowMs` falls within the KRX Regular Session wall-clock window —
 * a weekday between 09:00 and 15:30 KST. **Holiday-unaware by design**: a
 * weekday public holiday still reads true (holiday gating is the backend
 * calendar's responsibility, not this frontend predicate). Used to gate the
 * 60s past-data refetch so it stops outside trading hours.
 */
export function isKrxRegularSessionNow(nowMs: number = Date.now()): boolean {
  const today = realMsToYyyymmdd(nowMs);
  const wd = kstWeekday(today);
  if (wd === 0 || wd === 6) return false; // 주말
  return nowMs >= regularSessionOpenMs(today) && nowMs <= regularSessionCloseMs(today);
}

/** Convert a candle count to a calendar-day window large enough to fetch
 * ~that many candles at the given timeframe. Uses KRX 09:00–15:30 (390
 * trading minutes/day) and 5-trading-days-per-7-calendar-day density.
 * Slight overshoot is fine — the chart consumes whatever the backend
 * returns and lazy-extend fills any gap on the next pan.
 *
 * D uses the same 5/7 ratio (not a holiday-adjusted 252/365) for a clean,
 * single source of truth. Result for D=250 is 350 calendar days vs the
 * "perfect" 365 — close enough; the chart shows whatever ≤250 bars the
 * backend returns. */
function candleTargetToCalendarDays(target: number, tf: LiveTimeframe): number {
  if (tf === 'M') return target * 31;
  if (tf === 'W') return target * 7;
  if (tf === 'D') return Math.ceil(target / TRADING_DAYS_PER_CALENDAR_DAYS);
  const tfMinutes = TIMEFRAME_TO_MS[tf] / 60_000;
  const tradingDays = (target * tfMinutes) / TRADING_MINUTES_PER_DAY;
  return Math.ceil(tradingDays / TRADING_DAYS_PER_CALENDAR_DAYS);
}

/** D/W/M 한 스텝이 겨냥하는 캔들 개수. STEP_TRADING_DAYS 의 D/W/M 값을 이
 * 목표에서 유도해 "한 스텝 ≈ 50개 캔들" 불변식을 코드로 드러낸다(ADR-0104).
 * 분봉 스텝은 캔들 개수가 아니라 백엔드 병렬 배치 1회(5거래일)로 산정한다
 * (ADR-0105) — 스텝 폭의 단일 소스는 STEP_TRADING_DAYS. */
export const STEP_CANDLE_TARGET = 50;
const TRADING_DAYS_PER_WEEK = 5;
const TRADING_DAYS_PER_MONTH = 21;

/** 좌측 팬/줌 백필 한 스텝의 거래일 폭 — 전 타임프레임 단일 소스(ADR-0105).
 *
 * 스텝 날짜 계산은 전 타임프레임이 `subtractWeekdaysKst`(주말 스킵) 단일 경로를
 * 쓴다 — 거래일이 주식 데이터의 자연 단위라(일봉은 거래일에만 존재), 스텝당
 * 캔들 산출량이 주말 위치와 무관하게 일정해진다(1m = 5×390 = 1,950봉 고정).
 *
 * - 분봉(1m~30m): 5거래일. 백엔드 날짜-병렬 배치 1회로 첫 커밋 ~1.5-2.5s이면서
 *   딥 팬 총시간은 순차(1거래일 스텝) 대비 3~5배 단축(실측 2026-07-11). 초기
 *   로드 `INITIAL_MINUTE_TRADING_DAYS=5`와 동일 단위. 5거래일 ≈ 7~9캘린더일
 *   < 청크 캡 15일·백엔드 신선예산 12일이라 스텝당 요청은 항상 청크 1개.
 * - D/W/M: 캔들 STEP_CANDLE_TARGET(50)개 환산. D=50거래일, W=50주×5거래일,
 *   M=50개월×21거래일. D=50평일=70캘린더일(기존과 동치), W=250평일=350캘린더일
 *   (기존과 동치), M=1050평일≈1470캘린더일(기존 1550의 의도된 근사). */
export const STEP_TRADING_DAYS: Record<LiveTimeframe, number> = {
  '1m': 5,
  '3m': 5,
  '5m': 5,
  '10m': 5,
  '15m': 5,
  '30m': 5,
  D: STEP_CANDLE_TARGET,
  W: STEP_CANDLE_TARGET * TRADING_DAYS_PER_WEEK,
  M: STEP_CANDLE_TARGET * TRADING_DAYS_PER_MONTH,
};

/** 초기 분봉 fetch 폭(거래일). 콜드로드마다 받는 분봉 과거창의 크기를 정한다.
 *
 * 화면의 초기 뷰포트는 최근 ~300바(<1거래일)만 보여주고, 그 왼쪽은 사용자가 좌측
 * 끝을 넘어 팬하면 lazy-fetch(스텝=캔들 STEP_CANDLE_TARGET개)가 자동으로 채운다
 * (useViewportBackfill 3a/3b — 빈영역이 보이는 동안 settle-loop가 사용자 액션 없이
 * 화면 가득 찰 때까지 스텝 단위로 진행). 따라서 초기엔 "보이는 양 + 약간의 헤드룸"만
 * 받으면 충분하다.
 *
 * 과거엔 40캘린더일(=20cal×2 ≈ 28.6거래일 ≈ 11,143바)을 콜드로드마다 받아, 완전
 * uncached 종목 + KIS rate-limit(EGW00201) 상황에서 첫 fetch가 ~115 KIS 호출로
 * 90초+ 걸려 "분봉 불러오는 중…"이 길게 떴다(/diagnose 2026-06-09). 5거래일로 줄이면
 * 1m 기준 1,950바(≈7캘린더일) → KIS 호출 ~115→~20(≈6배↓)로 첫 그림이 빨라진다.
 * PAST_CANDLES_MAX_DAYS=250 클램프는 scroll-back 상한으로 그대로 유효.
 */
const INITIAL_MINUTE_TRADING_DAYS = 5;
export function initialCandleTargetFor(tf: LiveTimeframe): number {
  if (isMinuteTimeframe(tf)) {
    // 거래일 × (거래분/일 ÷ 봉분) = 그 거래일 수만큼의 봉 개수. 1m=1950, 5m=390, 30m=65.
    const tfMinutes = TIMEFRAME_TO_MS[tf] / 60_000;
    const candlesPerTradingDay = TRADING_MINUTES_PER_DAY / tfMinutes;
    return Math.round(INITIAL_MINUTE_TRADING_DAYS * candlesPerTradingDay);
  }
  // D/W/M: flat 250 candles per user spec. D ≈ 1 year, W ≈ 4.8 years, M ≈ 21 years
  // (most KRX stocks return less; backend serves whatever exists). 일봉 엔드포인트는
  // 250일 클램프가 없어 넓은 M 창도 그대로 통과.
  return 250;
}

/** Calendar-day window enclosing `initialCandleTargetFor(tf)` candles.
 * Wrapper for the seed-from computation in useLiveBundle. */
export function initialHistoricalDaysFor(tf: LiveTimeframe): number {
  return candleTargetToCalendarDays(initialCandleTargetFor(tf), tf);
}

/** base 날짜에서 타임프레임의 `steps`스텝(스텝당 `STEP_TRADING_DAYS`거래일)만큼
 * 과거의 YYYYMMDD. 전 타임프레임이 주말 스킵 단일 경로를 쓴다(`STEP_TRADING_DAYS`
 * 주석). 결과는 항상 base보다 strict 과거 — 두 kernel의 단조성 계약의 근거. */
function stepBackFrom(baseYyyymmdd: string, tf: LiveTimeframe, steps = 1): string {
  return subtractWeekdaysKst(baseYyyymmdd, STEP_TRADING_DAYS[tf] * Math.max(1, steps));
}

/** 한 번의 dispatch가 묶을 수 있는 최대 스텝 수 — 분봉 좌측 팬 전용(ADR-0120).
 *
 * 백필 스텝은 프론트에서 완전 직렬이다(3a settle-loop는 한 스텝이 착지해야 다음을
 * 낸다). 그래서 딥 팬의 총시간 = Σ스텝 왕복인데, 백엔드는 미캐시 날짜를 계정 슬롯에
 * 병렬 분산하므로 한 요청의 날짜 수를 늘려도 벽시계가 거의 안 는다 — 5일 단일요청과
 * 5×1일 순차의 실측 차가 3.2~5.7배였다(2026-07-11). 즉 스텝을 묶으면 같은 KIS
 * 쿼터로 왕복 횟수만 절반이 된다. prepend 커밋도 절반이라 render 측 비용도 준다.
 *
 * 상한이 2인 이유(세 상수가 맞물린 불변식 — 하나라도 바뀌면 여기를 재계산):
 *   2스텝 = 10평일 = **14캘린더일** ≤ `PAST_CHUNK_CALENDAR_DAYS`(15) → 요청이 항상
 *   청크 1개로 나가고, 10거래일 ≤ 백엔드 `max_fresh_dates_per_collect`(12) →
 *   fetch_budget_exhausted 경고 없이 한 collect에서 완결된다. 3스텝(15평일=21캘린더일)
 *   은 두 제약을 동시에 깨서 청크 분할 + 예산 유예로 오히려 느려진다.
 *
 * coverage_gap fill은 제외한다(항상 1스텝): 종료 조건이 예산이 아니라 날짜 수렴이라,
 * 묶으면 viewport가 보지도 않는 과거까지 지표 창을 넓혀 #582(wide-range) 재발이다. */
export const MAX_BATCH_STEPS_PER_DISPATCH = 2;

/** 이번 dispatch가 묶을 스텝 수. 남은 예산과 타임프레임 상한 중 작은 쪽.
 * 분봉 외(D/W/M)는 한 스텝이 이미 캔들 50개라 묶지 않는다. */
export function dispatchStepsFor(tf: LiveTimeframe, remainingBudget: number): number {
  const cap = isMinuteTimeframe(tf) ? MAX_BATCH_STEPS_PER_DISPATCH : 1;
  return Math.max(1, Math.min(cap, remainingBudget));
}

/** /live infinite-scroll backfill policy (SR-3), extracted pure from
 * LiveChartRoot's subscribeVisibleLogicalRangeChange effect.
 *
 * Given where the axis currently starts (`axisEarliestMs`, real Unix ms — the
 * first segment's session open), the date already requested
 * (`historicalFromDate`, or null before any extension), and the timeframe
 * (step sizing via `stepBackFrom`), returns the YYYYMMDD the next leftward
 * chunk should fetch back to.
 *
 * Base date: prefer `historicalFromDate` when it is strictly earlier than the
 * axis earliest. A chunk that lands on a holiday-only span (e.g. Lunar New
 * Year) leaves `axis.segments[0]` put, so basing off the axis would recompute
 * the same target and the store's monotonic guard would freeze extension.
 * Basing off `historicalFromDate` steps another chunk back regardless of
 * whether the server returned new trading days for the prior chunk. The result
 * is always strictly earlier than the base, so feeding it back is monotonic. */
export function nextHistoricalFrom(
  axisEarliestMs: number,
  historicalFromDate: string | null,
  tf: LiveTimeframe,
  steps = 1,
): string {
  const axisEarliestDate = realMsToYyyymmdd(axisEarliestMs);
  const baseDate =
    historicalFromDate !== null && historicalFromDate < axisEarliestDate
      ? historicalFromDate
      : axisEarliestDate;
  return stepBackFrom(baseDate, tf, steps);
}

/** Coverage-gap 백필(A안)의 다음 from. `nextHistoricalFrom`과 달리 axis earliest를
 * base로 쓰지 않는다 — 캔들이 병합 캐시로 수개월치 복원되면 axis가 수개월 과거라,
 * 그걸 base로 삼으면 첫 스텝이 수개월치 range 요청으로 폭발한다. 여기서는 지금 range가
 * 요청 중인 창(`historicalFromDate`, 아직 확장 전이면 `rangeWindowFromDate`)을 base로
 * 삼아 한 스텝씩만 과거로 걷는다. 결과는 항상 base보다 strict 과거이므로 스토어
 * `extendHistoricalRange`의 단조 감소 가드를 통과하고, 스텝마다 coverage 경계가 앞으로
 * 당겨져 viewport 좌단에 수렴한다(무한 루프 없음). */
export function nextCoverageFrom(
  historicalFromDate: string | null,
  rangeWindowFromDate: string,
  tf: LiveTimeframe,
): string {
  const base = historicalFromDate ?? rangeWindowFromDate;
  return stepBackFrom(base, tf);
}

/** 한 스텝이 실제로 가져오는 봉 수 추정. 제스처 예산 산정의 분모.
 * 분봉은 `STEP_TRADING_DAYS`거래일 × (거래분/일 ÷ 봉분) — 1m 한 스텝은
 * 5×390 = 1,950봉이다. D/W/M은 STEP_TRADING_DAYS가 캔들 50개에서 유도됐으므로
 * 정확히 STEP_CANDLE_TARGET(50)봉. */
export function stepCandlesEstimate(tf: LiveTimeframe): number {
  if (isMinuteTimeframe(tf)) {
    const tfMinutes = TIMEFRAME_TO_MS[tf] / 60_000;
    return STEP_TRADING_DAYS[tf] * (TRADING_MINUTES_PER_DAY / tfMinutes);
  }
  return STEP_CANDLE_TARGET;
}

/** 제스처 예산: 트리거 순간의 빈공간(바 수)을 채우는 데 필요한 스텝 수.
 * 이 예산이 fill의 유일한 종료 조건이다(클램프 제외) — fill 도중의 추가
 * 인터랙션은 예산을 늘리지 못하고(뷰포트 재측정 없음), fill은 예산만큼
 * 무조건 완주한다. 도중에 생긴 새 빈공간은 완료 후 다음 트리거의 예산으로
 * 배치 처리된다(/investigate 2026-07-11 설계 결정). */
export function fillBudgetSteps(whitespaceBars: number, tf: LiveTimeframe): number {
  return Math.max(1, Math.ceil(whitespaceBars / stepCandlesEstimate(tf)));
}

export interface FillStepArgs {
  /** 트리거가 정한 fill 종류. left_pan=캔들+지표 동반 확장(axis-base),
   * coverage_gap=range 창만 확장(window-base). */
  kind: 'left_pan' | 'coverage_gap';
  historicalFromDate: string | null;
  axisEarliestMs: number;
  /** Optional scrollback lower bound (YYYYMMDD). Minute charts pass the 250-day clamp; calendar charts pass null. */
  earliestAllowedDate: string | null;
  /** 스텝 크기 산정용(캔들 STEP_CANDLE_TARGET개 환산, `stepBackFrom`). */
  timeframe: LiveTimeframe;
  /** 이번 fill에서 지금까지 dispatch한 스텝 수. */
  stepCount: number;
  /** 이번 fill의 스텝 예산(트리거 순간 동결, `fillBudgetSteps`).
   * coverage_gap은 날짜 수렴이 주 종료 조건이라 백스톱 값을 넣는다. */
  budget: number;
  /** coverage_gap 전용: 트리거 순간의 viewport 좌단 날짜(수렴 목표, 동결). */
  coverageTargetDate?: string | null;
  /** 지금 range가 요청 중인 창의 from — coverage 스텝 base의 null-fallback. */
  rangeWindowFromDate?: string | null;
}

/** 한 스텝 settle 후 진행 루프가 멈출지 / 다음 from을 받을지 결정.
 *
 * 제스처 예산 모델(/investigate 2026-07-11): fill 진행 중에는 뷰포트를
 * 다시 측정하지 않는다 — 트리거 순간 동결된 예산·목표만 소진한다. 그래서
 * fill 도중의 줌인·줌아웃은 이번 fill을 늘리지도 줄이지도 못한다(추가
 * API 호출 0, 예산만큼 무조건 완주).
 *
 * 종료: (a) 예산 소진(stepCount ≥ budget) (b) optional 하한(클램프) 도달
 * (c) coverage_gap은 요청 창이 동결된 목표 날짜에 도달했을 때.
 * 연휴 스텝(거래일 0개)도 예산 1을 소모한다 — 그만큼 덜 채워진 빈공간은
 * 다음 트리거의 예산으로 회수된다(자가 치유).
 *
 * `steps`는 이번 dispatch가 소모하는 예산 단위 수다(분봉 left_pan은 최대
 * `MAX_BATCH_STEPS_PER_DISPATCH`개 묶음, 그 외 1). 호출자는 stepCount에 이 값을
 * 더해야 한다 — 1씩 더하면 묶은 만큼 예산이 과다 집행돼 fill이 목표를 넘어간다. */
export function planFillStep(
  args: FillStepArgs,
): { action: 'stop' } | { action: 'fetch'; nextFrom: string; steps: number } {
  const {
    kind, historicalFromDate, axisEarliestMs, earliestAllowedDate,
    timeframe, stepCount, budget,
    coverageTargetDate = null, rangeWindowFromDate = null,
  } = args;
  if (stepCount >= budget) return { action: 'stop' };
  if (earliestAllowedDate !== null && historicalFromDate !== null && historicalFromDate <= earliestAllowedDate) {
    return { action: 'stop' };
  }
  if (kind === 'left_pan') {
    const steps = dispatchStepsFor(timeframe, budget - stepCount);
    return {
      action: 'fetch',
      nextFrom: nextHistoricalFrom(axisEarliestMs, historicalFromDate, timeframe, steps),
      steps,
    };
  }
  // coverage_gap: 요청 창이 동결된 목표(트리거 순간 viewport 좌단)에 닿으면 종료.
  if (coverageTargetDate === null || rangeWindowFromDate === null) return { action: 'stop' };
  const windowFrom = historicalFromDate ?? rangeWindowFromDate;
  if (windowFrom <= coverageTargetDate) return { action: 'stop' };
  return {
    action: 'fetch',
    nextFrom: nextCoverageFrom(historicalFromDate, rangeWindowFromDate, timeframe),
    steps: 1, // 날짜 수렴이 종료 조건 — 묶으면 목표를 지나쳐 과다 요청(#582)
  };
}
