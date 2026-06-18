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

export function isSyntheticHogaGapPoint(p: QuoteRatioPoint): p is HogaGapPoint {
  return (p as Partial<HogaGapPoint>).__syntheticHogaGap === true;
}

export function withHogaGapSentinels(
  points: readonly QuoteRatioPoint[],
  candles: readonly Candle[],
  bucketMs: number,
): QuoteRatioPoint[] {
  if (bucketMs <= 0) throw new Error(`bucketMs must be positive, got ${bucketMs}`);
  const real = [...points].sort((a, b) => a.t - b.t);
  if (real.length === 0 || candles.length === 0) return real;

  const hogaTimes = new Set(real.map((p) => p.t));
  const firstHogaT = real[0].t;
  const lastHogaT = real[real.length - 1].t;
  const sentinelByT = new Map<number, HogaGapPoint>();

  for (const c of candles) {
    const t = bucketStart(c.ts_ms, bucketMs);
    if (t < firstHogaT || t > lastHogaT || hogaTimes.has(t)) continue;
    sentinelByT.set(t, syntheticGapPoint(t));
  }

  if (sentinelByT.size === 0) return real;
  return [...real, ...sentinelByT.values()].sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    if (isSyntheticHogaGapPoint(a) === isSyntheticHogaGapPoint(b)) return 0;
    return isSyntheticHogaGapPoint(a) ? 1 : -1;
  });
}
