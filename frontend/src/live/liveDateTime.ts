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

/** 좌측 팬 한 스텝의 캘린더일 크기.
 *
 * - 분봉: 고정 3거래일(=latency cap). 3거래일을 5/7 밀도로 환산 → 5 캘린더일.
 *   주말 1회를 한 스텝에 항상 덮어 빈 결과 재드래그를 막는 최소값.
 *   `STEP_TRADING_DAYS`는 실측 후 조정 가능한 단일 상수(데이터를 덜 받는 게
 *   아니라 첫 그림 시점·렌더 분할 횟수만 바뀐다).
 * - D/W/M: 기존 one-shot 윈도 유지(진행 루프는 minute-only). 한 번의 팬으로
 *   ~1년치를 그려 채우므로 스텝 분할이 불필요. */
const STEP_TRADING_DAYS = 3;
export function stepChunkDays(tf: LiveTimeframe): number {
  if (isMinuteTimeframe(tf)) {
    return Math.ceil(STEP_TRADING_DAYS / TRADING_DAYS_PER_CALENDAR_DAYS);
  }
  if (tf === 'D') return candleTargetToCalendarDays(250, tf);
  return candleTargetToCalendarDays(120, tf); // W, M
}

/** 초기 분봉 fetch 폭(거래일). 콜드로드마다 받는 분봉 과거창의 크기를 정한다.
 *
 * 화면의 초기 뷰포트는 최근 ~300바(<1거래일)만 보여주고, 그 왼쪽은 사용자가 좌측
 * 끝을 넘어 팬하면 lazy-fetch(stepChunkDays=5캘린더일)가 자동으로 채운다
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

/** /live infinite-scroll backfill policy (SR-3), extracted pure from
 * LiveChartRoot's subscribeVisibleLogicalRangeChange effect.
 *
 * Given where the axis currently starts (`axisEarliestMs`, real Unix ms — the
 * first segment's session open), the date already requested
 * (`historicalFromDate`, or null before any extension), and the caller-injected
 * `chunkDays` (use `stepChunkDays(tf)`), returns the YYYYMMDD the next leftward
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
  chunkDays: number,
): string {
  const axisEarliestDate = realMsToYyyymmdd(axisEarliestMs);
  const baseDate =
    historicalFromDate !== null && historicalFromDate < axisEarliestDate
      ? historicalFromDate
      : axisEarliestDate;
  return subtractDaysKst(baseDate, chunkDays);
}

export interface FillStepArgs {
  /** getVisibleLogicalRange().from — 음수면 왼쪽 빈영역. null이면 측정 불가. */
  visibleFrom: number | null;
  historicalFromDate: string | null;
  axisEarliestMs: number;
  /** 250일 클램프 하한(YYYYMMDD). earliestAllowedMinuteDate(today). */
  earliestAllowedDate: string;
  /** stepChunkDays(tf). */
  stepCalendarDays: number;
  /** 이번 fill에서 지금까지 dispatch한 스텝 수. */
  stepCount: number;
  /** 무한 루프 백스톱. */
  maxSteps: number;
}

/** 한 스텝 settle 후 진행 루프가 멈출지 / 다음 from을 받을지 결정.
 *
 * 종료: (a) viewport 꽉 참(visibleFrom ≥ 0) (b) 측정 불가(null) (c) 250일 클램프
 * 하한 도달 (d) 백스톱(stepCount ≥ maxSteps). 그 외엔 cur-base nextHistoricalFrom
 * 으로 한 스텝 더 과거를 받는다. 연휴 스텝(거래일 0개)은 여기서 멈추지 않는다 —
 * cur-base가 다음 스텝을 자동으로 더 과거로 보낸다. */
export function planFillStep(
  args: FillStepArgs,
): { action: 'stop' } | { action: 'fetch'; nextFrom: string } {
  const { visibleFrom, historicalFromDate, axisEarliestMs, earliestAllowedDate, stepCalendarDays, stepCount, maxSteps } = args;
  if (visibleFrom === null || visibleFrom >= 0) return { action: 'stop' };
  if (stepCount >= maxSteps) return { action: 'stop' };
  if (historicalFromDate !== null && historicalFromDate <= earliestAllowedDate) {
    return { action: 'stop' };
  }
  return {
    action: 'fetch',
    nextFrom: nextHistoricalFrom(axisEarliestMs, historicalFromDate, stepCalendarDays),
  };
}
