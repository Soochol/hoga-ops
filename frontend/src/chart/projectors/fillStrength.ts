import {
  HistogramSeries,
  LineSeries,
  type HistogramData,
  type LineData,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import { useShallow } from 'zustand/react/shallow';
import { useActivePrefs } from '../../state/chartPrefs';
import type { RangeBundle, FillStrengthPoint } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokensThemed } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';
import { addZeroBaselineGuide } from '../util/zeroBaseline';
import { isAuctionHidden, LINE_HIDDEN_COLOR } from '../util/auctionHide';
import { makePastCachedProjector, lowerBoundT } from './pastCachedProjector';

// buy/sell/cumulative are applied at series-options level (thunked below), not
// embedded per data point — the histogram/line data carries no color, so the
// P0 past-caches need no theme key (unlike candle/volume whose data embeds it).
const TOKEN_SPEC = {
  buy: ['--price-up', '#F04452'],          // 체결 매수 (KRX 빨강)
  sell: ['--price-down', '#3485FA'],       // 체결 매도 (KRX 파랑)
  // 체결강도 누적 — derived signal. --fg-dim (mid gray) is dark enough to
  // read as "neutral derived" against the chart bg without colliding with
  // the Zero Baseline Guide's --fg-dimmer (which is darker still).
  cumulative: ['--fg-dim', '#9A9AA8'],
  cumulativeBaseline: ['--fg-dimmer', '#63636F'], // 0-baseline guide
} as const;

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

export const cumulativePriceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => v.toLocaleString('ko-KR'),  // sign preserved
  minMove: 1,
};

// Auction-window hide (ADR-0029, util/auctionHide.ts). Histograms accept
// WhitespaceData and render nothing for it — unlike LineSeries / BaselineSeries
// the histogram actually skips the bar at a whitespace, so we don't need the
// per-point transparent-color trick that the line/baseline projectors use.
export function projectBuy(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): (HistogramData<Time> | WhitespaceData<Time>)[] {
  return projectBuyPoints(bundle.fill_strength.points, axis, auctionWindowMask);
}

/** Points-array variant of {@link projectBuy} — per-point (auction = whitespace,
 * no retroactive rewrite), so the /live past-cache split is trivially correct. */
export function projectBuyPoints(
  points: readonly FillStrengthPoint[],
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): (HistogramData<Time> | WhitespaceData<Time>)[] {
  const out: (HistogramData<Time> | WhitespaceData<Time>)[] = [];
  for (const p of points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
    if (isAuctionHidden(axis, auctionWindowMask, p.t)) {
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
): (HistogramData<Time> | WhitespaceData<Time>)[] {
  return projectSellPoints(bundle.fill_strength.points, axis, auctionWindowMask);
}

/** Points-array variant of {@link projectSell}. */
export function projectSellPoints(
  points: readonly FillStrengthPoint[],
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): (HistogramData<Time> | WhitespaceData<Time>)[] {
  const out: (HistogramData<Time> | WhitespaceData<Time>)[] = [];
  for (const p of points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
    if (isAuctionHidden(axis, auctionWindowMask, p.t)) {
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
  if (axis.mode === 'calendar') return [];
  const out: (LineData<Time> | WhitespaceData<Time>)[] = [];
  bundle.segments.forEach((seg, segIdx) => {
    const segOut = projectCumulativeSegment(
      seg,
      segIdx,
      bundle.fill_strength.points,
      axis,
      auctionWindowMask,
      bundle.bucket_ms,
      segIdx === bundle.segments.length - 1,
    );
    for (const e of segOut) out.push(e);
  });
  return out;
}

/** One Stock-Date segment's worth of {@link projectCumulativeNetFill} emissions.
 * Extracted so the /live tick path can cache past segments (immutable intra-
 * session) and recompute only today's segment per tick (makeCumulativeCached-
 * Projector). Each segment is self-contained: runningSum resets to 0, the
 * day-boundary break/zero-anchor only read the absolute `segIdx`/`segOpenVirtual`
 * (not prior `out` state), and lastPreAuctionIdx indexes this segment's local
 * `out`. So flat-mapping segments reproduces the original single-`out` loop
 * byte-for-byte (pastCachedProjector.test.ts). `points` may be the whole array
 * (the bound check filters) or a pre-sliced segment window. */
export function projectCumulativeSegment(
  seg: RangeBundle['segments'][number],
  segIdx: number,
  points: readonly FillStrengthPoint[],
  axis: VirtualAxis,
  auctionWindowMask: boolean,
  bucketMs: number,
  isLastSegment: boolean,
): (LineData<Time> | WhitespaceData<Time>)[] {
  const out: (LineData<Time> | WhitespaceData<Time>)[] = [];
  let runningSum = 0;
  let firstEmittedInSeg = true;
  // Index into `out` of the most recent non-hidden emission for this
  // segment. Used after the source-points loop to paint its outgoing
  // segment transparent so the line doesn't visibly slope into the
  // value=0 auction anchor at 15:20.
  let lastPreAuctionIdx = -1;
  for (const p of points) {
    if (p.t < seg.session_open_ms || p.t > seg.session_close_ms) continue;
    runningSum += p.buy_qty - p.sell_qty;
    if (!axis.contains(p.t)) continue;
    const thisVirtual = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;

    // In-window source points are intentionally NOT emitted here: the
    // per-bucket transparent anchor synthesis below covers the same slot,
    // and emitting both would push two entries at identical virtual
    // seconds (backend bucket_ms grid aligns source points with anchor
    // slots), which lightweight-charts rejects with "data must be asc
    // ordered by time". `runningSum` has already accumulated above, so
    // the "hide is rendering, not data" invariant from ADR-0029 holds.
    if (isAuctionHidden(axis, auctionWindowMask, p.t)) continue;

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
    lastPreAuctionIdx = out.length - 1;
  }

  // Paint the last pre-auction emission's outgoing segment transparent, AND
  // (below) synthesize transparent anchors across the auction window — both
  // exist solely to prevent a diagonal line drawing THROUGH the auction band
  // INTO THE NEXT SEGMENT (ADR-0029). isLastSegment marks the terminal segment
  // of whatever range is loaded — there's no next segment for a diagonal to
  // bleed into, so both are visually meaningless there and are suppressed via
  // !isLastSegment. This holds for ANY last segment, not just a live/today
  // one: browsing a past (non-live) range whose last loaded day is fully
  // closed still gets isLastSegment=true and the same suppression — a missing
  // anchor/gap artifact there is this gate working as designed, not a bug.
  //
  // The suppression also happens to make the /live tick path cheap when the
  // last segment IS today's live segment: keeping these active there would
  // force a per-tick setData fallback in seriesDataDiff.ts's
  // classifyDataChange, because (a) the retroactive color rewrite below
  // mutates a PRIOR emission's `color` field (breaking the byte-identical-
  // prefix precondition for the tail-append 'update' path) and (b) the
  // future anchor synthesis inserts points AFTER the segment's last real
  // point, which also breaks the tail-append prefix on every subsequent
  // tick. Suppressing both lets live ticks append cleanly — but that's a
  // bonus of the rule, not its scope.
  //
  // lightweight-charts uses each point's `color` for its OUTGOING segment,
  // so without this patch the connector from (e.g.) 15:19's gray cumulative
  // value to the value=0 synthesized anchor at 15:20 stays visible — the
  // line bends toward zero at the auction boundary instead of disappearing
  // cleanly. Skipped when there's no pre-auction emission to attach to
  // (viewport starts inside the auction window): the synthesized anchors
  // alone cover the visible region.
  if (auctionWindowMask && !isLastSegment && lastPreAuctionIdx >= 0) {
    out[lastPreAuctionIdx] = {
      ...(out[lastPreAuctionIdx] as LineData<Time>),
      ...LINE_HIDDEN_COLOR,
    };
  }

  // Synthesize transparent-color anchors across the auction window even
  // though `fill_strength.points` carries none (backend filters Auction Cross
  // rows). Without anchors the cumulative line would draw a direct segment
  // from this segment's last cumulative value to the next segment's first —
  // the exact diagonal-across-the-band bug ADR-0029 documents for the
  // line/baseline projectors. Same fix shape (transparent per-point color
  // at every in-window bar) applied here at bucket resolution. Suppressed in
  // the last segment (see comment above the color-patch block).
  if (auctionWindowMask && !isLastSegment) {
    const auctionStart = seg.session_close_ms - 10 * 60 * 1000;
    // Stop strictly before session_close — the next segment's day-boundary
    // whitespace lands at `segOpenVirtual - 1` which converts back to the
    // current segment's session_close virtual second, so emitting an anchor
    // at session_close would collide (setData requires strictly ascending
    // unique times). The 15:29 anchor is sufficient: its outgoing segment
    // (transparent) covers the gap into the next-day whitespace + zero
    // anchor.
    for (let t = auctionStart; t < seg.session_close_ms; t += bucketMs) {
      if (!axis.contains(t)) continue;
      const time = (axis.toVirtual(t) / 1000) as UTCTimestamp;
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
    }
  }
  return out;
}

/** P0 과거/당일 분리 캐시 — 누적 체결강도 전용(세그먼트 단위). 일반
 * makePastCachedProjector를 못 쓰는 이유: runningSum이 그 세그먼트의 후속 emit
 * 전부에 의존(마지막 버킷 변동 → 당일 라인 전체 갱신)하고, 경매 anchor가 라이브 점과
 * 시간순으로 뒤섞여 단순 tail-append가 불가하다. 대신 세그먼트별로 쪼개 — 과거
 * 세그먼트(0..N-2)는 불변이라 캐시, 당일 세그먼트(N-1)만 매 틱 재투영. 당일 segIdx>0를
 * 그대로 넘겨 일경계 break/zero anchor 불변식을 보존한다. */
export function makeCumulativeCachedProjector(): (
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
) => (LineData<Time> | WhitespaceData<Time>)[] {
  const cache = new WeakMap<
    VirtualAxis,
    { mask: boolean; pastLen: number; pastLastT: number; pastData: (LineData<Time> | WhitespaceData<Time>)[] }
  >();
  return (bundle, axis, mask) => {
    if (axis.mode === 'calendar') return [];
    const segs = bundle.segments;
    if (segs.length < 2) return projectCumulativeNetFill(bundle, axis, mask);

    const points = bundle.fill_strength.points;
    const bucketMs = bundle.bucket_ms;
    const todayIdx = segs.length - 1;
    const todaySeg = segs[todayIdx];
    const splitIdx = lowerBoundT(points, todaySeg.session_open_ms);
    const pastPoints = points.slice(0, splitIdx);
    const todayPoints = points.slice(splitIdx);
    const pastLastT = splitIdx > 0 ? pastPoints[splitIdx - 1].t : 0;

    let entry = cache.get(axis);
    if (!entry || entry.mask !== mask || entry.pastLen !== splitIdx || entry.pastLastT !== pastLastT) {
      const pastData: (LineData<Time> | WhitespaceData<Time>)[] = [];
      for (let i = 0; i < todayIdx; i++) {
        const segOut = projectCumulativeSegment(segs[i], i, pastPoints, axis, mask, bucketMs, false);
        for (const e of segOut) pastData.push(e);
      }
      entry = { mask, pastLen: splitIdx, pastLastT, pastData };
      cache.set(axis, entry);
    }
    return entry.pastData.concat(
      projectCumulativeSegment(todaySeg, todayIdx, todayPoints, axis, mask, bucketMs, true),
    );
  };
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

// P0 과거/당일 분리 캐시 (매수/매도 히스토그램만 — per-point라 분리 안전). 캐시 키는
// auctionWindowMask boolean(cumulativeEnabled는 이 시리즈에 영향 없음). 누적 라인은
// runningSum이 후속 전부에 의존해 분리 불가 → 아래 cumulative 캐시를 별도로 쓴다.
const buyCachedData = makePastCachedProjector(projectBuyPoints, (b) => b.fill_strength.points);
const sellCachedData = makePastCachedProjector(projectSellPoints, (b) => b.fill_strength.points);
export const cumulativeCachedData = makeCumulativeCachedProjector();

export const FILL_STRENGTH_SPEC = {
  name: 'fill-strength' as const,
  live: true, // reads fill_strength (SSE-derived) → fed the live bundle on /live
  stretch: 0.4,
  legendToggleKey: 'fillStrengthEnabled',
  legendTitle: '체결강도',
  useContext: useFillStrengthContext,
  series: [
    {
      type: HistogramSeries,
      options: () => ({ color: resolveTokensThemed(TOKEN_SPEC).buy, ...histOpts }),
      data: (bundle, axis, ctx) => buyCachedData(bundle, axis, ctx.auctionWindowMask),
      legend: { label: '매수', color: () => resolveTokensThemed(TOKEN_SPEC).buy },
    },
    {
      type: HistogramSeries,
      options: () => ({ color: resolveTokensThemed(TOKEN_SPEC).sell, ...histOpts }),
      data: (bundle, axis, ctx) => sellCachedData(bundle, axis, ctx.auctionWindowMask),
      legend: { label: '매도', color: () => resolveTokensThemed(TOKEN_SPEC).sell },
    },
    {
      type: LineSeries,
      // Gated on ctx.cumulativeEnabled → empty projector when off → value null →
      // the overlay omits this cell (no toggle knowledge in the legend model).
      legend: { label: '누적', color: () => resolveTokensThemed(TOKEN_SPEC).cumulative },
      options: () => ({
        color: resolveTokensThemed(TOKEN_SPEC).cumulative,
        lineWidth: 2,
        lineStyle: 0,          // solid
        priceScaleId: '',      // invisible overlay scale — autoscale split from histograms
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: cumulativePriceFormat,
      }),
      data: (bundle, axis, ctx) =>
        ctx.cumulativeEnabled ? cumulativeCachedData(bundle, axis, ctx.auctionWindowMask) : [],
      afterAdd: (series) => addZeroBaselineGuide(series, resolveTokensThemed(TOKEN_SPEC).cumulativeBaseline),
    },
  ],
} satisfies PaneSpec<FillStrengthPaneContext>;
