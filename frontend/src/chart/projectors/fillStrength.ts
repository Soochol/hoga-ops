import {
  HistogramSeries,
  LineSeries,
  type LineData,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import { useShallow } from 'zustand/react/shallow';
import { useActivePrefs } from '../../state/chartPrefs';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';
import { addZeroBaselineGuide } from '../util/zeroBaseline';

const TOKEN_SPEC = {
  buy: ['--price-up', '#DC2626'],          // 체결 매수 (KRX 빨강)
  sell: ['--price-down', '#2563EB'],       // 체결 매도 (KRX 파랑)
  // 체결강도 누적 — derived signal. --fg-dim (mid gray) is dark enough to
  // read as "neutral derived" against the chart bg without colliding with
  // the Zero Baseline Guide's --fg-dimmer (which is darker still).
  cumulative: ['--fg-dim', '#94A3B8'],
  cumulativeBaseline: ['--fg-dimmer', '#64748B'], // 0-baseline guide
} as const;

const { buy, sell, cumulative, cumulativeBaseline } = resolveTokens(TOKEN_SPEC);

const histOpts = {
  base: 0,
  priceFormat: {
    type: 'custom' as const,
    formatter: (v: number) => Math.round(Math.abs(v)).toLocaleString('ko-KR'),
    minMove: 1,
  },
  priceLineVisible: false,
  lastValueVisible: false,
};

const cumulativePriceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => v.toLocaleString('ko-KR'),  // sign preserved
  minMove: 1,
};

// Auction-window hide (ADR-0029): emit WhitespaceData for in-window points.
// Histograms render nothing for WhitespaceData (no bar drawn), so this matches
// the prior "skip" semantics visually while keeping the time scale's bar-index
// density intact for the AuctionWindowOverlay band.
export function projectBuy(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): any[] {
  const out: any[] = [];
  for (const p of bundle.fill_strength.points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as any;
    if (auctionWindowMask && axis.inClosingAuctionWindow(p.t)) {
      out.push({ time });
      continue;
    }
    out.push({ time, value: p.buy_qty });
  }
  return out;
}

export function projectSell(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): any[] {
  const out: any[] = [];
  for (const p of bundle.fill_strength.points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as any;
    if (auctionWindowMask && axis.inClosingAuctionWindow(p.t)) {
      out.push({ time });
      continue;
    }
    out.push({ time, value: -p.sell_qty });
  }
  return out;
}

/**
 * Per-Stock-Date running sum of `(buy_qty − sell_qty)` over FillStrength's
 * bucketed continuous-trade series — the **Cumulative Net Fill** indicator
 * (CONTEXT.md "Cumulative Net Fill (체결강도 누적)").
 *
 * Two independent predicates gate the per-point work:
 *   - in-session (segment[i].session_open_ms ≤ p.t ≤ session_close_ms):
 *     gates whether the point contributes to the running sum. Pre-open and
 *     after-hours points are skipped.
 *   - in-viewport (axis.contains(p.t)): gates whether the cumulative value
 *     is emitted to the series.
 *
 * Splitting these is load-bearing: zooming into mid-session keeps the line
 * starting from the correct 09:00-anchored baseline rather than re-zeroing
 * at the viewport edge.
 *
 * Per-Stock-Date semantics: runningSum resets to 0 at each segment start.
 * Two additional emissions per segment make the reset *visible* on the
 * rendered line:
 *
 *   - **Whitespace break** at `segOpenVirtual − 1` for non-first segments:
 *     a `WhitespaceData` point (time only, no value) tells lightweight-
 *     charts to break the line between segments. Without it the prior
 *     day's last cumulative value would draw a diagonal straight into the
 *     new day's first emitted value — visually identical to "the new day
 *     continues from yesterday's total".
 *
 *   - **Zero anchor** at `segOpenVirtual` when (a) session_open is in
 *     viewport and (b) no actual fill point lands exactly at session_open:
 *     a `{ time: segOpenVirtual, value: 0 }` point makes each day's line
 *     visibly *start from zero* even when the first fill bucket is several
 *     minutes into the session. When the first fill happens at session
 *     open (e.g. opening-cross-derived bucket), the anchor is suppressed
 *     to avoid timestamp collision; the actual point's value carries the
 *     first bucket's net delta. When session_open is out of viewport
 *     (zoomed-in mid-session), the anchor is suppressed and the line
 *     resumes from the correct running sum at the first in-viewport point.
 *
 * Closing Auction Window (ADR-0029): when `auctionWindowMask` is true,
 * in-window points keep their time slot but their outgoing line segment is
 * painted with transparent `color` so the auction band shows no line.
 * WhitespaceData was tried and discarded — LineSeries v5 silently
 * interpolates across whitespace, so day-1 close would still draw a
 * diagonal into day-2's first cumulative point. `runningSum` continues to
 * accumulate (the "hide is rendering, not data" invariant) — in practice
 * no in-window points exist because the backend filters them, but the
 * invariant stays clean.
 */
export function projectCumulativeNetFill(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): (LineData<Time> | WhitespaceData<Time>)[] {
  const out: (LineData<Time> | WhitespaceData<Time>)[] = [];
  bundle.segments.forEach((seg, segIdx) => {
    let runningSum = 0;
    let firstEmittedInSeg = true;
    for (const p of bundle.fill_strength.points) {
      if (p.t < seg.session_open_ms || p.t > seg.session_close_ms) continue;
      runningSum += p.buy_qty - p.sell_qty;
      if (!axis.contains(p.t)) continue;
      const thisVirtual = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;

      if (auctionWindowMask && axis.inClosingAuctionWindow(p.t)) {
        out.push({ time: thisVirtual, value: 0, color: 'rgba(0,0,0,0)' });
        continue;
      }

      if (firstEmittedInSeg) {
        const segOpenVirtual = (axis.toVirtual(seg.session_open_ms) / 1000) as UTCTimestamp;
        if (segIdx > 0) {
          // Break the cumulative line so the prior day's last value doesn't
          // visually continue into this day. Whitespace point: time only.
          // Day-boundary breaks work because we follow up with a value=0
          // anchor at segOpenVirtual — lightweight-charts v5 does NOT
          // break LineSeries at WhitespaceData on its own, so the visible
          // "break" you see at day boundaries is actually the line ramping
          // from prior cumulative down to 0. See ADR-0029.
          out.push({ time: ((segOpenVirtual as number) - 1) as UTCTimestamp });
        }
        // Suppress the zero anchor when the first visible point falls inside
        // the closing Auction Window: a 6h flat-zero pre-auction baseline
        // before the first cumulative reading is more misleading than useful.
        if (
          axis.contains(seg.session_open_ms) &&
          (segOpenVirtual as number) < (thisVirtual as number) &&
          !axis.inClosingAuctionWindow(p.t)
        ) {
          out.push({ time: segOpenVirtual, value: 0 });
        }
        firstEmittedInSeg = false;
      }

      out.push({ time: thisVirtual, value: runningSum });
    }
  });
  return out;
}

export type FillStrengthPaneContext = {
  cumulativeEnabled: boolean;
  auctionWindowMask: boolean;
};

// Single primitive selector; useShallow ensures the object literal reference
// is stable when the boolean doesn't change. Without useShallow, every render
// creates a new {cumulativeEnabled: ...} object, which the RangeSeriesPane
// data effect treats as a context change and re-projects (cheap but wasteful).
// Same pattern as useRatioContext in ratio.ts.
const useFillStrengthContext = (): FillStrengthPaneContext =>
  useActivePrefs(
    useShallow((p): FillStrengthPaneContext => ({
      cumulativeEnabled: p.fillStrengthCumulative,
      auctionWindowMask: p.auctionWindowMask,
    })),
  );

export const FILL_STRENGTH_SPEC = {
  name: 'fill-strength' as const,
  stretch: 0.4,
  useContext: useFillStrengthContext,
  series: [
    {
      type: HistogramSeries,
      options: { color: buy, ...histOpts },
      data: (bundle, axis, ctx) => projectBuy(bundle, axis, ctx.auctionWindowMask),
    },
    {
      type: HistogramSeries,
      options: { color: sell, ...histOpts },
      data: (bundle, axis, ctx) => projectSell(bundle, axis, ctx.auctionWindowMask),
    },
    {
      type: LineSeries,
      options: {
        color: cumulative,
        lineWidth: 2,
        lineStyle: 0,          // solid
        priceScaleId: '',      // invisible overlay scale — autoscale split from histograms
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: cumulativePriceFormat,
      },
      data: (bundle, axis, ctx) =>
        ctx.cumulativeEnabled ? projectCumulativeNetFill(bundle, axis, ctx.auctionWindowMask) : [],
      afterAdd: (series) => addZeroBaselineGuide(series, cumulativeBaseline),
    },
  ],
} satisfies PaneSpec<FillStrengthPaneContext>;
