import type { Candle, QuoteRatioPoint } from '../../api/types';

export type HogaGapPoint = QuoteRatioPoint & { __syntheticHogaGap: true };

const ZERO_HOGA_FIELDS = {
  bid_total: 0,
  ask_total: 0,
  bid_max: 0,
  ask_max: 0,
  imb_max_bid: 0,
  imb_max_ask: 0,
} as const;

function bucketStart(t: number, bucketMs: number): number {
  return Math.floor(t / bucketMs) * bucketMs;
}

function syntheticGapPoint(t: number): HogaGapPoint {
  return { t, ...ZERO_HOGA_FIELDS, __syntheticHogaGap: true };
}

function lowerBoundCandleBucket(candles: readonly Candle[], bucketMs: number, t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bucketStart(candles[mid].ts_ms, bucketMs) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function isSyntheticHogaGapPoint(p: QuoteRatioPoint): p is HogaGapPoint {
  return (p as Partial<HogaGapPoint>).__syntheticHogaGap === true;
}

export interface HogaGapSentinelBounds {
  firstHogaT?: number;
  lastHogaT?: number;
  fromT?: number;
  toT?: number;
}

export function withHogaGapSentinels(
  points: readonly QuoteRatioPoint[],
  candles: readonly Candle[],
  bucketMs: number,
  bounds: HogaGapSentinelBounds = {},
): QuoteRatioPoint[] {
  if (bucketMs <= 0) throw new Error(`bucketMs must be positive, got ${bucketMs}`);
  const real = [...points].sort((a, b) => a.t - b.t);
  if (real.length === 0 || candles.length === 0) return real;

  const hogaTimes = new Set(real.map((p) => p.t));
  const firstHogaT = bounds.firstHogaT ?? real[0].t;
  const lastHogaT = bounds.lastHogaT ?? real[real.length - 1].t;
  const fromT = bounds.fromT ?? Number.NEGATIVE_INFINITY;
  const toT = bounds.toT ?? Number.POSITIVE_INFINITY;
  const sentinelByT = new Map<number, HogaGapPoint>();

  const startIdx = Number.isFinite(fromT) ? lowerBoundCandleBucket(candles, bucketMs, fromT) : 0;
  const endIdx = Number.isFinite(toT) ? lowerBoundCandleBucket(candles, bucketMs, toT) : candles.length;

  for (let i = startIdx; i < endIdx; i++) {
    const c = candles[i];
    const t = bucketStart(c.ts_ms, bucketMs);
    if (t < fromT || t >= toT || t < firstHogaT || t > lastHogaT || hogaTimes.has(t)) continue;
    sentinelByT.set(t, syntheticGapPoint(t));
  }

  if (sentinelByT.size === 0) return real;
  return [...real, ...sentinelByT.values()].sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    if (isSyntheticHogaGapPoint(a) === isSyntheticHogaGapPoint(b)) return 0;
    return isSyntheticHogaGapPoint(a) ? 1 : -1;
  });
}
