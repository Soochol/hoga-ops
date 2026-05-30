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
export function createKstHorzScaleBehavior(axisRef: MutableRefObject<VirtualAxis>) {
  const Base = defaultHorzScaleBehavior();
  class KstHorzScaleBehavior extends Base {
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
      // Loading: no segments yet → no axis mapping is available. The library's
      // own base impl only populates the internal `_internal_timeWeight` field
      // (minified `.Sf`) and never the public `timeWeight`, so delegating to it
      // would (a) crash on internal-less points and (b) leave the public field
      // at its sentinel. Instead compute the same weight ladder directly over
      // the public `originalTime` (treated as UTC seconds), writing ONLY the
      // public `timeWeight`. This keeps us crash-free and minification-safe
      // until the real axis arrives.
      if (axis.segments.length === 0) {
        const utc = (p: { readonly originalTime: unknown }): Date =>
          new Date((p.originalTime as number) * 1000);
        for (let i = Math.max(startIndex, 1); i < pts.length; i++) {
          pts[i].timeWeight = weightByKstDate(utc(pts[i]), utc(pts[i - 1]));
        }
        if (startIndex === 0 && pts.length >= 2) {
          pts[0].timeWeight = weightByKstDate(utc(pts[1]), utc(pts[0]));
        }
        return;
      }
      const kst = (p: { readonly originalTime: unknown }): Date =>
        new Date(axis.toReal((p.originalTime as number) * 1000) + KST_OFFSET_MS);

      const begin = Math.max(startIndex, 1);
      for (let i = begin; i < pts.length; i++) {
        pts[i].timeWeight = weightByKstDate(kst(pts[i]), kst(pts[i - 1]));
      }
      // R4: points[0] has no predecessor. Estimate its tier from the NEXT
      // point's real-KST delta (symmetric) rather than the library's
      // virtual-space average, which is meaningless under gap compression.
      if (startIndex === 0 && pts.length >= 2) {
        pts[0].timeWeight = weightByKstDate(kst(pts[1]), kst(pts[0]));
      }
    }
  }
  return new KstHorzScaleBehavior();
}
