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

/** Days of past data seeded on initial mount so the chart shows usable history
 * without requiring the user to scroll. ~4 trading weeks of minute bars. */
export const INITIAL_HISTORICAL_DAYS = 20;

/** Calendar days to backfill per scroll-past-leftmost event, sized to a
 * candle-count target rather than a uniform calendar window.
 *
 * - Minute timeframes: 21 calendar days ≈ 15 trading days ≈ ~5850 1m
 *   candles per chunk. The earlier 2-day chunk had a weekend trap (Monday
 *   earliest minus 2 lands on Saturday → zero new trading days, then the
 *   livePage store's monotonic-decrease guard froze further extension).
 *   21 days survives weekends, single holidays, and most multi-day KRX
 *   closures in a single chunk. Longer closures (rare, e.g. Lunar New Year
 *   when bracketed by weekends) are still handled by LiveChartRoot's
 *   trigger: it bases the next chunk off the already-requested
 *   `historicalFromDate` rather than the axis, so each pan jumps another
 *   21 days back regardless of whether new data arrived.
 * - Calendar timeframes: D → 180 calendar days (~120 trading days). W/M
 *   scale proportionally; the 250-day cap (PAST_CANDLES_MAX_DAYS in
 *   useLiveBundle) clamps them, so one scroll on W/M jumps to the
 *   available limit. */
export function prefetchChunkDaysFor(tf: LiveTimeframe): number {
  if (isMinuteTimeframe(tf)) return 21;
  if (tf === 'D') return 180;
  if (tf === 'W') return 60 * 7;
  return 60 * 31; // tf === 'M'
}
