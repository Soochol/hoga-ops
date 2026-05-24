import { HistogramSeries, LineSeries, type LineData, type Time, type UTCTimestamp } from 'lightweight-charts';
import { useShallow } from 'zustand/react/shallow';
import { useActivePrefs } from '../../state/chartPrefs';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  buy: ['--price-up', '#DC2626'],          // 체결 매수 (KRX 빨강)
  sell: ['--price-down', '#2563EB'],       // 체결 매도 (KRX 파랑)
  cumulative: ['--fg', '#E5E7EB'],         // 체결강도 누적 — neutral (derived signal)
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

export function projectBuy(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.fill_strength.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: (axis.toVirtual(p.t) / 1000) as any, value: p.buy_qty }));
}

export function projectSell(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.fill_strength.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: (axis.toVirtual(p.t) / 1000) as any, value: -p.sell_qty }));
}

/**
 * Per-Stock-Date running sum of `(buy_qty − sell_qty)` over FillStrength's
 * bucketed continuous-trade series — the **Cumulative Net Fill** indicator
 * (CONTEXT.md "Cumulative Net Fill (체결강도 누적)").
 *
 * Two independent predicates:
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
 * Resets to 0 at each new segment boundary (per-Stock-Date semantics).
 */
export function projectCumulativeDelta(
  bundle: RangeBundle,
  axis: VirtualAxis,
): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  for (const seg of bundle.segments) {
    let runningSum = 0;
    for (const p of bundle.fill_strength.points) {
      if (p.t < seg.session_open_ms || p.t > seg.session_close_ms) continue;
      runningSum += p.buy_qty - p.sell_qty;
      if (!axis.contains(p.t)) continue;
      out.push({
        time: (axis.toVirtual(p.t) / 1000) as UTCTimestamp,
        value: runningSum,
      });
    }
  }
  return out;
}

export type FillStrengthPaneContext = {
  cumulativeEnabled: boolean;
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
      data: (bundle, axis) => projectBuy(bundle, axis),
    },
    {
      type: HistogramSeries,
      options: { color: sell, ...histOpts },
      data: (bundle, axis) => projectSell(bundle, axis),
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
        ctx.cumulativeEnabled ? projectCumulativeDelta(bundle, axis) : [],
      afterAdd: (series) => {
        series.createPriceLine({
          price: 0,
          color: cumulativeBaseline,
          lineWidth: 1,
          lineStyle: 1,         // dotted
          axisLabelVisible: false,
          title: '',
        });
      },
    },
  ],
} satisfies PaneSpec<FillStrengthPaneContext>;
