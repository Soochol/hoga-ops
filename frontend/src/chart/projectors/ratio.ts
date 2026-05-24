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
import { isAuctionMaskActive } from '../../util/auctionMask';
import { resolveTokens } from '../../util/tokens';
import { useShallow } from 'zustand/react/shallow';
import { useActivePrefs } from '../../state/chartPrefs';
import type { PaneSpec } from '../RangeSeriesPane';
import { addZeroBaselineGuide } from '../util/zeroBaseline';

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
  // Backend (build_quote_ratio_slice) now buckets on linear ms-from-midnight
  // and guarantees strictly-ascending unique timestamps per ADR-0010. If
  // setData ever throws "asc ordered by time" again, the regression is on
  // the backend side; sortAndDedupeByTime in util/time.ts is still available
  // as a defense-in-depth wrapper.
  return bundle.quote_ratio.points
    .filter((p) => axis.contains(p.t))
    .map((p) => {
      const raw = quoteImbalance(p.bid_total, p.ask_total);
      // Outlier clamp: priceFormat above renders `1 + |raw|`, so the chart
      // label crosses `outlierThreshold` once ask/bid (or bid/ask) reaches
      // that multiple. Such spikes dominate the autoscale and flatten the
      // meaningful signal — mask to 0 alongside the auction-window mask.
      // Threshold + enable flag are per-tab prefs (ChartViewPrefs).
      const isExtreme =
        ctx.outlierFilterEnabled && 1 + Math.abs(raw) >= ctx.outlierThreshold;
      return {
        time: (axis.toVirtual(p.t) / 1000) as UTCTimestamp,
        // CONTEXT.md "Auction Window" — during 15:20–15:30 the bid/ask ratio is
        // dominated by one-sided accumulation. `isAuctionMaskActive` owns the
        // rule (per-tab toggle + axis threshold).
        value:
          isAuctionMaskActive(ctx.auctionWindowMask, axis, p.t) || isExtreme
            ? 0
            : raw,
      };
    });
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
