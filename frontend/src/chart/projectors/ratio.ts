import {
  BaselineSeries,
  type BaselineData,
  type LineWidth,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { quoteImbalance } from '../../util/imbalance';
import { resolveTokens } from '../../util/tokens';
import { useShallow } from 'zustand/react/shallow';
import { useActivePrefs } from '../../state/chartPrefs';
import type { PaneSpec } from '../RangeSeriesPane';
import { addZeroBaselineGuide } from '../util/zeroBaseline';
import { isAuctionHidden, BASELINE_HIDDEN_COLORS, maskOutgoingConnector } from '../util/auctionHide';

const TOKEN_SPEC = {
  // KRX 컨벤션: 매수=상승=빨강, 매도=하락=파랑. RatioPane은 price-direction
  // 토큰을 직접 차용해 의미 충돌 없음 (도서 압력 부호와 가격 방향이 정렬됨).
  ratioBid: ['--price-up', '#DC2626'],
  ratioAsk: ['--price-down', '#2563EB'],
  baseline: ['--fg-dimmer', '#64748B'],
} as const;

const { ratioBid, ratioAsk, baseline } = resolveTokens(TOKEN_SPEC);

/**
 * Convert a `#RRGGBB` hex string to `rgba(R, G, B, a)`. Used to derive
 * the soft gradient fill colors for `BaselineSeries`' top/bottom areas
 * from the solid token colors.
 */
function rgba(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const priceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => {
    if (Math.abs(v) < 0.005) return '0';
    return (1 + Math.abs(v)).toFixed(1);
  },
  minMove: 0.01,
};

export type RatioPaneContext = {
  auctionWindowMask: boolean;
  outlierFilterEnabled: boolean;
  outlierThreshold: number;
};

export function projectRatio(
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: RatioPaneContext,
): BaselineData<Time>[] {
  const out: BaselineData<Time>[] = [];
  for (const p of bundle.quote_ratio.points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
    // Auction-window hide (ADR-0029, util/auctionHide.ts). Skipping the
    // outlier check is intentional: a hidden point has no value to clamp.
    // Break the connector from the last pre-auction point so the baseline
    // doesn't slope into the window.
    if (isAuctionHidden(axis, ctx.auctionWindowMask, p.t)) {
      maskOutgoingConnector(out, BASELINE_HIDDEN_COLORS);
      out.push({ time, value: 0, ...BASELINE_HIDDEN_COLORS });
      continue;
    }
    // A fully-auction bucket is excluded upstream by emitting (0,0) totals
    // (bucketHogaSeries / query_bucketed_ratio, ADR-0062). No NaN guard is
    // needed here: quoteImbalance returns 0 for a degenerate (≤0) book
    // (util/imbalance.ts), so an excluded bucket renders flat at 0 — matching
    // the 총잔량 pane — in both the mask-ON and mask-OFF views.
    const raw = quoteImbalance(p.bid_total, p.ask_total);
    // Outlier clamp (ADR-0026): mask the value to 0 when the chart-label
    // magnitude crosses the user threshold. The point stays on the time
    // axis at value=0 — outliers are scattered and have no natural break.
    const isExtreme =
      ctx.outlierFilterEnabled && 1 + Math.abs(raw) >= ctx.outlierThreshold;
    out.push({ time, value: isExtreme ? 0 : raw });
  }
  return out;
}

// Single selector + useShallow so the returned object reference is stable
// when none of the three fields change. Without useShallow, every call to
// this hook returns a fresh object literal — and RangeSeriesPane's data
// effect (`useEffect(..., [bundle, axis, ctx, spec])`) re-runs every
// render, whose setData triggers chart range subscribers that round-trip
// into React state, producing "Maximum update depth exceeded". Same
// pattern as useCursor.ts.
const useRatioContext = (): RatioPaneContext =>
  useActivePrefs(
    useShallow((p) => ({
      auctionWindowMask: p.auctionWindowMask,
      outlierFilterEnabled: p.ratioOutlierFilterEnabled,
      outlierThreshold: p.ratioOutlierThreshold,
    })),
  );

export const RATIO_SPEC = {
  name: 'ratio' as const,
  live: true, // reads quote_ratio (SSE-derived) → fed the live bundle on /live
  stretch: 0.4,
  useContext: useRatioContext,
  series: [
    {
      type: BaselineSeries,
      options: {
        baseValue: { type: 'price', price: 0 },
        // Gradient relative to the data range, not the full pane. Without this,
        // when data hugs the baseline (small imbalances near 0), the fill
        // sits in the "near-baseline" alpha (0.1) zone and reads as invisible.
        // With true, the saturated fill (0.55) is concentrated at the data
        // peaks where the user actually looks.
        relativeGradient: true,
        topLineColor: ratioAsk,
        topFillColor1: rgba(ratioAsk, 0.55),
        topFillColor2: rgba(ratioAsk, 0.1),
        bottomLineColor: ratioBid,
        bottomFillColor1: rgba(ratioBid, 0.1),
        bottomFillColor2: rgba(ratioBid, 0.55),
        // Bumped from 1.4 → 3: at the typical pane height (~62px) with
        // mostly small-magnitude imbalance values plus rare outlier spikes
        // that dominate the autoscale, hairlines disappear into the baseline.
        // A 3px stroke survives both the small-magnitude near-baseline runs
        // and the cross-day extreme spikes that compress the visible range.
        lineWidth: 3 satisfies LineWidth,
        // Suppress the library-default horizontal line + right-axis chip at the
        // latest value. Analysts read the latest ratio via crosshair.
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat,
      },
      data: projectRatio,
      afterAdd: (series) => {
        // 0-baseline reference line. Drawn explicitly because BaselineSeries
        // switches color at baseValue but does not paint a visible line there.
        // Color is --fg-dimmer (neutral) so it reads as a reference, not data.
        addZeroBaselineGuide(series, baseline);
      },
    },
  ],
} satisfies PaneSpec<RatioPaneContext>;
