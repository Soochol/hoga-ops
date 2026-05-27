/**
 * KST date/time helpers for /live.
 *
 * Centralises the YYYYMMDD KST conversion, the previous-day arithmetic, and
 * the default Regular Session bounds. /live components (`LiveChartRoot`,
 * `useLiveBundle`, `LiveStatusBar`) all need "what date is right now in
 * Korea?" — keeping the math in one place means localising any future
 * Half-Day Session handling to a single module.
 */

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

/** Days of additional past data fetched each time the user scrolls past the
 * currently-loaded window. Smaller than INITIAL so the seed loads quickly and
 * subsequent extensions stay small. */
export const PREFETCH_CHUNK_DAYS = 10;
