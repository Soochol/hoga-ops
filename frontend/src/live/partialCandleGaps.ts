import type { Candle, RangeSegment } from '../api/types';
import { minuteBucketStartMs } from './aggregateCandles';

/** A hole is a reason to ask the provider, not proof that trades are missing.
 * Use the supplied session bounds (including shortened/extended sessions).
 * Zero-volume bars occupy a bucket just like every other observed bar. */
export function partialCandleGapDates(
  candles: readonly Candle[], segments: readonly RangeSegment[], bucketMs: number,
): string[] {
  const occupied = new Set(candles.map(c => minuteBucketStartMs(c.ts_ms, bucketMs)));
  return segments.filter(segment => {
    for (let t = segment.session_open_ms; t <= segment.session_close_ms; t += 60_000) {
      if (!occupied.has(minuteBucketStartMs(t, bucketMs))) return true;
    }
    return false;
  }).map(s => s.date);
}

/** Keep every disk OHLCV, even when a provider disagrees. Add only observed
 * provider buckets absent from disk; never forward-fill a missing minute. */
export function supplementalCandles(
  disk: readonly Candle[], provider: readonly Candle[], bucketMs: number,
): readonly Candle[] {
  if (disk.length === 0) return provider;
  const occupied = new Set(disk.map(c => minuteBucketStartMs(c.ts_ms, bucketMs)));
  return provider.filter(c => !occupied.has(minuteBucketStartMs(c.ts_ms, bucketMs)));
}
