import { useEffect } from 'react';
import { LineSeries, type IChartApi } from 'lightweight-charts';
import type { SessionBundle } from '../api/types';
import { type Segment, realToVirtual, isWithinSessions } from '../util/time';
import { quoteImbalance } from '../util/imbalance';
import { resolveTokens } from '../util/tokens';

const TOKEN_SPEC = { accent: ['--accent', '#14B8A6'] } as const;

type Props = {
  chart: IChartApi;
  bundle: SessionBundle;
  segments: Segment[];
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
 * mapping each point's real Unix-ms timestamp through `realToVirtual`.
 */
export default function RatioPane({ chart, bundle, segments, paneIndex = 0 }: Props) {
  useEffect(() => {
    const { accent } = resolveTokens(TOKEN_SPEC);
    const series = chart.addSeries(
      LineSeries,
      {
        color: accent,
        // lightweight-charts wants an integer 1-4; the design calls for a
        // hair-line emphasis, but the runtime accepts a float here.
        lineWidth: 1.4 as any,
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
    const data = bundle.quote_ratio.points
      .filter((p) => isWithinSessions(segments, p.t))
      .map((p) => ({
        time: (realToVirtual(segments, p.t) / 1000) as any,
        value: quoteImbalance(p.bid_total, p.ask_total),
      }));
    series.setData(data);
    // 0-baseline reference line (lineStyle 1 = solid).
    series.createPriceLine({
      price: 0,
      color: accent,
      lineWidth: 1,
      lineStyle: 1,
      axisLabelVisible: false,
      title: '',
    } as any);
    return () => {
      chart.removeSeries(series);
    };
  }, [chart, bundle, segments, paneIndex]);
  return null;
}
