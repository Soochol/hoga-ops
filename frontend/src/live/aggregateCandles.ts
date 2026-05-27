import type { LivePastCandle as LiveCandle } from '../api/livePastCandles';

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
