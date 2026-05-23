import { useEffect } from 'react';
import { BaselineSeries, type IChartApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { type VirtualAxis } from '../util/virtualAxis';
import { quoteImbalance } from '../util/imbalance';
import { resolveTokens } from '../util/tokens';
import { useTabsStore } from '../state/tabs';

/**
 * Closing Auction Window starts at sessionOpenMs + 6h 20m (KST 15:20).
 * Mirrors CandlePane.tsx's per-segment threshold (CONTEXT.md "Auction
 * Window"). During this band, derived ratios are dominated by one-sided
 * accumulation and read as misleading extremes; the toggle on the tabs
 * store gates the mask on a per-tab basis.
 */
const AUCTION_WINDOW_OFFSET_MS = (6 * 3600 + 20 * 60) * 1000;

const TOKEN_SPEC = {
  ratioAsk: ['--ratio-ask', '#3B82F6'],
  // Reused: same hex as price-direction --down, but here it encodes
  // bid-heavy order-book pressure (below 0). Inline comment marks the
  // semantic distinction so future maintainers don't refactor it away.
  ratioBid: ['--down', '#F43F5E'],
  baseline: ['--fg-dimmer', '#64748B'],
} as const;

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

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  /** Pane index for multi-pane split. Defaults to 0. */
  paneIndex?: number;
};

/**
 * RatioPane — mounts a LineSeries onto the shared chart instance and paints
 * the signed bid/ask imbalance over time. The value is 0-centered:
 *   +x → ask-heavy (sell pressure), formatted "Nx S"
 *   -x → bid-heavy (buy pressure),  formatted "Nx B"
 *
 * Returns null; this component only controls the series lifecycle (add on
 * mount, remove on unmount). Multi-day x-axis stitching is handled by
 * mapping each point's real Unix-ms timestamp through `axis.toVirtual`.
 */
export default function RatioPane({ chart, bundle, axis, paneIndex = 0 }: Props) {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const auctionWindowMask = useTabsStore(
    (s) => s.getPrefs(activeTabId).auctionWindowMask,
  );
  useEffect(() => {
    const { ratioAsk, ratioBid, baseline } = resolveTokens(TOKEN_SPEC);
    const series = chart.addSeries(
      BaselineSeries,
      {
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
        lineWidth: 3 as any,
        // Suppress the library-default horizontal line at the latest value.
        // The right-axis chip still shows the latest value via lastValueVisible.
        priceLineVisible: false,
        priceFormat: {
          type: 'custom',
          formatter: (v: number) => {
            if (Math.abs(v) < 0.005) return '0';
            const r = (1 + Math.abs(v)).toFixed(1);
            return v >= 0 ? `${r}× S` : `${r}× B`;
          },
          minMove: 0.01,
        },
      },
      paneIndex,
    );
    // Backend (build_quote_ratio_slice) now buckets on linear ms-from-midnight
    // and guarantees strictly-ascending unique timestamps per ADR-0010. If
    // setData ever throws "asc ordered by time" again, the regression is on
    // the backend side; sortAndDedupeByTime in util/time.ts is still available
    // as a defense-in-depth wrapper.
    const data = bundle.quote_ratio.points
      .filter((p) => axis.contains(p.t))
      .map((p) => {
        const segIdx = axis.findByReal(p.t);
        const seg = axis.segments[segIdx];
        const inAuctionWindow =
          p.t >= seg.sessionOpenMs + AUCTION_WINDOW_OFFSET_MS;
        return {
          time: (axis.toVirtual(p.t) / 1000) as any,
          value: auctionWindowMask && inAuctionWindow
            ? 0
            : quoteImbalance(p.bid_total, p.ask_total),
        };
      });
    series.setData(data);
    // 0-baseline reference line. Drawn explicitly because BaselineSeries
    // switches color at baseValue but does not paint a visible line there.
    // Color is --fg-dimmer (neutral) so it reads as a reference, not data.
    series.createPriceLine({
      price: 0,
      color: baseline,
      lineWidth: 1,
      lineStyle: 1,
      axisLabelVisible: false,
      title: '',
    } as any);
    return () => {
      // Guard: when a sibling pane throws and ChartErrorBoundary unmounts
      // ChartStage, the parent's chart.remove() may run before this cleanup,
      // leaving the series handle dangling. lightweight-charts then throws
      // "Value is undefined" inside removeSeries.
      try {
        chart.removeSeries(series);
      } catch {
        // chart already torn down — safe to ignore
      }
    };
  }, [chart, bundle, axis, paneIndex, auctionWindowMask]);
  return null;
}
