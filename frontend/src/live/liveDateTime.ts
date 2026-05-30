/**
 * KST date/time helpers for /live.
 *
 * Centralises the YYYYMMDD KST conversion, the previous-day arithmetic, and
 * the default Regular Session bounds. /live components (`LiveChartRoot`,
 * `useLiveBundle`, `LiveStatusBar`) all need "what date is right now in
 * Korea?" — keeping the math in one place means localising any future
 * Half-Day Session handling to a single module.
 */
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import { TIMEFRAME_TO_MS } from '../api/types';

const TRADING_MINUTES_PER_DAY = 390;        // KRX 09:00–15:30 = 6.5 h
const TRADING_DAYS_PER_CALENDAR_DAYS = 5 / 7;

/** Today's YYYYMMDD in KST. */
export function todayKstYyyymmdd(): string {
  return realMsToYyyymmdd(Date.now());
}

/** Convert a real Unix ms timestamp to its YYYYMMDD KST date. */
export function realMsToYyyymmdd(realMs: number): string {
  const kst = new Date(realMs + 9 * 3_600_000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
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

/** Target candle count for the initial fetch on (code, timeframe) mount.
 *
 * - Minute timeframes: 2× of the previous 20-calendar-day window. At 1m
 *   that's ~11,143 candles ≈ 40 calendar days ≈ ~28.6 trading days.
 *   PAST_CANDLES_MAX_DAYS=250 in useLiveBundle still caps the eventual
 *   scroll-back depth at 250 calendar days; the initial 40-day window is
 *   well below it.
 * - D/W/M: flat 250 candles per user spec. D ≈ 1 year, W ≈ 4.8 years,
 *   M ≈ 21 years (most KRX stocks return less; backend serves whatever
 *   exists). The daily endpoint has no 250-day cap so the wide M window
 *   passes through unclamped. */
export function initialCandleTargetFor(tf: LiveTimeframe): number {
  if (isMinuteTimeframe(tf)) {
    const tfMinutes = TIMEFRAME_TO_MS[tf] / 60_000;
    const candlesPerCalendarDay = (TRADING_DAYS_PER_CALENDAR_DAYS * TRADING_MINUTES_PER_DAY) / tfMinutes;
    return Math.round(20 * candlesPerCalendarDay * 2);
  }
  return 250;
}

/** Target candle count to prepend per scroll-past-leftmost event.
 *
 * - Minute timeframes: 2× of the previous 21-calendar-day chunk. The
 *   21-day baseline survived weekend / single-holiday traps where shorter
 *   chunks landed on non-trading days and froze the livePage store's
 *   monotonic-decrease guard. At 2× that's ~11,700 1m candles ≈ 42
 *   calendar days, even more weekend-safe.
 * - D: 250 candles (2× of the previous 180-day ≈ ~125-candle chunk) ≈
 *   350 calendar days per pan.
 * - W/M: 120 candles (2× of the previous 60-week / 60-month chunks). */
export function prefetchChunkCandlesFor(tf: LiveTimeframe): number {
  if (isMinuteTimeframe(tf)) {
    const tfMinutes = TIMEFRAME_TO_MS[tf] / 60_000;
    const candlesPerCalendarDay = (TRADING_DAYS_PER_CALENDAR_DAYS * TRADING_MINUTES_PER_DAY) / tfMinutes;
    return Math.round(21 * candlesPerCalendarDay * 2);
  }
  if (tf === 'D') return 250;
  return 120; // W, M
}

/** Calendar-day window enclosing `initialCandleTargetFor(tf)` candles.
 * Wrapper for the seed-from computation in useLiveBundle. */
export function initialHistoricalDaysFor(tf: LiveTimeframe): number {
  return candleTargetToCalendarDays(initialCandleTargetFor(tf), tf);
}

/** Calendar-day window enclosing `prefetchChunkCandlesFor(tf)` candles.
 * Wrapper for the lazy-extend trigger in LiveChartRoot. */
export function prefetchChunkDaysFor(tf: LiveTimeframe): number {
  return candleTargetToCalendarDays(prefetchChunkCandlesFor(tf), tf);
}

/** /live infinite-scroll backfill policy (SR-3), extracted pure from
 * LiveChartRoot's subscribeVisibleLogicalRangeChange effect.
 *
 * Given where the axis currently starts (`axisEarliestMs`, real Unix ms — the
 * first segment's session open) and the date already requested
 * (`historicalFromDate`, or null before any extension), returns the YYYYMMDD
 * the next leftward chunk should fetch back to.
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
): string {
  const axisEarliestDate = realMsToYyyymmdd(axisEarliestMs);
  const baseDate =
    historicalFromDate !== null && historicalFromDate < axisEarliestDate
      ? historicalFromDate
      : axisEarliestDate;
  return subtractDaysKst(baseDate, prefetchChunkDaysFor(tf));
}
