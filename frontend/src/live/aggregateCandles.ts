import type { LivePastCandle as LiveCandle } from '../api/livePastCandles';
import { realMsToYyyymmdd, regularSessionOpenMs, regularSessionCloseMs } from './liveDateTime';

/** Drop bars outside the regular session [09:00, 15:30] KST for their own date.
 * Calendar (D/W/M) aggregation runs on this so pre/post-market minute bars do
 * not skew the day's OHLC. Generic over `{t_ms}` so it applies to raw KIS bars
 * and Candle-shaped rows alike. */
export function keepRegularSessionCandles<T extends { t_ms: number }>(candles: readonly T[]): T[] {
  return candles.filter((c) => {
    const date = realMsToYyyymmdd(c.t_ms);
    return c.t_ms >= regularSessionOpenMs(date) && c.t_ms <= regularSessionCloseMs(date);
  });
}

/** OHLCV aggregation of a sorted 1m candle stream into `bucketSeconds`-sized
 * buckets, aligned to the Unix epoch.
 *
 * Inputs may arrive in either order (KIS returns DESC; our hydrate also
 * de-duplicates) — the caller is expected to pre-sort ascending. We assert
 * that here only via the bucket-floor monotonicity check; out-of-order input
 * silently produces wrong open/close, so callers must respect the contract.
 *
 * Bucket time is the bucket-start in seconds (UTCTimestamp shape) — matches
 * what lightweight-charts expects. Zero-volume 1m bars are kept (they carry
 * a price snapshot even with no trades), so empty buckets are only those
 * with no source bars at all.
 */
export interface AggregatedCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function aggregateCandles(
  source: readonly LiveCandle[],
  bucketSec: number,
): AggregatedCandle[] {
  if (bucketSec <= 0) throw new Error(`bucketSec must be positive, got ${bucketSec}`);
  if (source.length === 0) return [];
  const bucketMs = bucketSec * 1000;
  const out: AggregatedCandle[] = [];
  let cur: AggregatedCandle | null = null;
  for (const c of source) {
    const bucketStart = Math.floor(c.t_ms / bucketMs) * bucketMs;
    if (cur === null || bucketStart !== cur.t_ms) {
      if (cur !== null) out.push(cur);
      cur = {
        t_ms: bucketStart,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Calendar-based bucket key for the KST date that owns `t_ms`. Returns a
 * string so D/W/M can all use string equality (epoch-floor breaks W & M
 * because their period lengths vary with month boundaries and leap weeks).
 * KST = UTC+9; shift first, then read calendar fields. */
export function calendarBucketKey(t_ms: number, granularity: 'D' | 'W' | 'M'): string {
  const kst = new Date(t_ms + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  if (granularity === 'M') return `${y}-${m}`;
  if (granularity === 'D') return `${y}-${m}-${d}`;
  // W: ISO-ish week starting Monday. JS day 0=Sun..6=Sat; offset to Mon=0..Sun=6.
  const dow = kst.getUTCDay();
  const offsetToMon = (dow + 6) % 7;
  const monday = new Date(Date.UTC(y, m, d - offsetToMon));
  return `W:${monday.getUTCFullYear()}-${monday.getUTCMonth()}-${monday.getUTCDate()}`;
}

/** OHLCV aggregation into calendar-aligned buckets (Day / Week / Month) in
 * KST. Unlike `aggregateCandles`, the result's `t_ms` is the **first source
 * bar's timestamp** for that bucket — i.e. the trading session's opening
 * minute. This keeps the aggregated point inside the owning Segment's
 * `[sessionOpenMs, sessionCloseMs]` so `axis.contains` admits it. The
 * alternative (synthetic midnight / Monday-midnight / month-first-midnight)
 * would land in a Gap and get filtered out.
 *
 * Inputs MUST be sorted ascending by `t_ms`; caller's contract, same as
 * `aggregateCandles`.
 */
export function aggregateCalendar(
  source: readonly LiveCandle[],
  granularity: 'D' | 'W' | 'M',
): AggregatedCandle[] {
  if (source.length === 0) return [];
  const out: AggregatedCandle[] = [];
  let cur: AggregatedCandle | null = null;
  let curKey: string | null = null;
  for (const c of source) {
    const key = calendarBucketKey(c.t_ms, granularity);
    if (curKey === null || key !== curKey) {
      if (cur !== null) out.push(cur);
      curKey = key;
      cur = {
        t_ms: c.t_ms,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
    } else if (cur !== null) {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}
