import { defaultHorzScaleBehavior } from 'lightweight-charts';
import type { TimeChartOptions } from 'lightweight-charts';
import type { MutableRefObject } from 'react';
import type { VirtualAxis } from './virtualAxis';

const KST_OFFSET_MS = 9 * 3600_000;

/**
 * Mirror of lightweight-charts' TickMarkWeight ladder, ascending by divisor.
 * Calendar tiers (Year/Month/Day) are handled separately by getUTC* equality;
 * these intraday tiers compare `Math.floor(getTime() / divisor)`. We feed a
 * KST-shifted Date, so the floor buckets align to KST hour/minute edges.
 */
const INTRADAY: ReadonlyArray<{ divisorMs: number; weight: number }> = [
  { divisorMs: 1000, weight: 10 }, // Second
  { divisorMs: 60_000, weight: 20 }, // Minute1
  { divisorMs: 300_000, weight: 21 }, // Minute5
  { divisorMs: 1_800_000, weight: 22 }, // Minute30
  { divisorMs: 3_600_000, weight: 30 }, // Hour1
  { divisorMs: 10_800_000, weight: 31 }, // Hour3
  { divisorMs: 21_600_000, weight: 32 }, // Hour6
  { divisorMs: 43_200_000, weight: 33 }, // Hour12
];

/** Port of lightweight-charts' `weightByTime`, but over real KST dates. */
function weightByKstDate(cur: Date, prev: Date): number {
  if (cur.getUTCFullYear() !== prev.getUTCFullYear()) return 70; // Year
  if (cur.getUTCMonth() !== prev.getUTCMonth()) return 60; // Month
  if (cur.getUTCDate() !== prev.getUTCDate()) return 50; // Day
  for (let i = INTRADAY.length - 1; i >= 0; i--) {
    const d = INTRADAY[i].divisorMs;
    if (Math.floor(prev.getTime() / d) !== Math.floor(cur.getTime() / d)) {
      return INTRADAY[i].weight;
    }
  }
  return 0; // LessThanSecond
}

/**
 * A horizontal-scale behavior whose tick weights follow the REAL KST calendar
 * instead of the gap-compressed virtual-1970 calendar the library would infer
 * from our virtual-second candle times. This revives native zoom-adaptive tier
 * selection (month → day → time) on the Virtual Axis.
 *
 * Load-bearing constraint: reads ONLY the public `originalTime` field (= the
 * virtual seconds we fed as candle `time`) and writes ONLY the public
 * `timeWeight` field. Internal fields are minified (`_internal_timestamp` →
 * `.Sf` in the production bundle), so touching them would break `vite build`.
 */
/** Multiplier separating axis generations in `cacheKey`. `super.cacheKey`
 * returns the tick's virtual time in ms (< 2^41 even for real-anchored
 * origins ≈ 1.8e12); generations stay integer-exact up to 2^53 / 2^41 = 4096,
 * far beyond any session's prepend count. */
const CACHE_GEN_STRIDE = 2 ** 41;

export function createKstHorzScaleBehavior(axisRef: MutableRefObject<VirtualAxis>) {
  const Base = defaultHorzScaleBehavior();
  // Axis generation for label-cache keying. lightweight-charts caches
  // formatted tick labels per (weight, cacheKey(time)) in an LRU that
  // SURVIVES setData, and two axis generations can place bars on the SAME
  // virtual time at different real dates even with real-anchored origins
  // (origins differ by whole days; ladders step 23,401s — cross-index value
  // collisions are exact, e.g. 16 days × 86,400s = 60 × 23,401s − 21,660s).
  // Folding a per-axis generation into the key makes stale entries
  // unreachable; the LRU evicts them.
  let cacheGen = 0;
  let cacheGenAxis: VirtualAxis | null = null;
  class KstHorzScaleBehavior extends Base {
    override cacheKey(internalItem: Parameters<InstanceType<typeof Base>['cacheKey']>[0]): number {
      const axis = axisRef.current;
      if (axis !== cacheGenAxis) {
        cacheGenAxis = axis;
        cacheGen++;
      }
      return cacheGen * CACHE_GEN_STRIDE + super.cacheKey(internalItem);
    }

    // Narrow the options type to TimeChartOptions so createChartEx's options
    // param (DeepPartial<ReturnType<behavior["options"]>>) carries
    // `timeScale.tickMarkFormatter`. The base's options() returns
    // ChartOptionsImpl<Time> whose timeScale is HorzScaleOptions (no
    // tickMarkFormatter); only TimeChartOptions narrows it to TimeScaleOptions.
    // This mirrors what createChart() gets for free (ChartOptions =
    // TimeChartOptions). Runtime is unchanged — pure type narrowing.
    override options(): TimeChartOptions {
      return super.options() as TimeChartOptions;
    }

    // Loose signature: base wants `readonly Mutable<TimeScalePoint>[]` but
    // `Mutable` isn't exported and `TimeScalePoint.timeWeight` is readonly in
    // the public typings. `readonly unknown[]` is wider (contravariant-OK) and
    // we cast internally to the minimal shape we actually use.
    fillWeightsForPoints(points: readonly unknown[], startIndex: number): void {
      const axis = axisRef.current;
      const pts = points as Array<{ readonly originalTime: unknown; timeWeight: number }>;
      // Map a point's public `originalTime` (virtual seconds) to the KST Date
      // whose calendar fields drive the weight ladder. Once the axis has
      // segments, virtual → real via axis.toReal, then +9h KST. While still
      // loading (no segments), there is no mapping yet, so treat originalTime
      // as raw UTC seconds — a harmless approximation for the brief pre-data
      // flash. We deliberately do NOT delegate to super here: the base impl
      // reads the internal `_internal_timestamp` field (minified `.Sf`), which
      // would both violate our public-fields-only constraint and leave the
      // public `timeWeight` unset. (Plan said "super fallback"; using the
      // public field instead is the load-bearing correction.)
      const toDate =
        axis.segments.length === 0
          ? (p: { readonly originalTime: unknown }): Date =>
              new Date((p.originalTime as number) * 1000)
          : (p: { readonly originalTime: unknown }): Date =>
              new Date(axis.toReal((p.originalTime as number) * 1000) + KST_OFFSET_MS);

      // Carry the previous point's Date across iterations — toDate runs a
      // binary search + Date allocation, so converting each point once (not
      // once as `cur` and again as next iteration's `prev`) halves the cost
      // of a full-history refill (~5,000 points on 1m).
      const start = Math.max(startIndex, 1);
      if (pts.length > start) {
        let prev = toDate(pts[start - 1]);
        for (let i = start; i < pts.length; i++) {
          const cur = toDate(pts[i]);
          pts[i].timeWeight = weightByKstDate(cur, prev);
          prev = cur;
        }
      }
      // R4: points[0] has no predecessor. Estimate its tier from the NEXT
      // point's delta (symmetric) rather than the library's virtual-space
      // average, which is meaningless under gap compression.
      if (startIndex === 0 && pts.length >= 2) {
        pts[0].timeWeight = weightByKstDate(toDate(pts[1]), toDate(pts[0]));
      }
    }
  }
  return new KstHorzScaleBehavior();
}
