import { useEffect, useRef } from 'react';
import type { IPriceLine, ISeriesApi, PriceLineOptions, SeriesType } from 'lightweight-charts';
import type { LineStyle } from '../chart/drawing/types';
import { toLwcLineStyle } from '../chart/util/lineStyle';

type Props = {
  /** Pane primary series to hang the price line on. Undefined when the pane
   *  isn't mounted (e.g. D/W/M timeframe) → renders nothing. */
  series: ISeriesApi<SeriesType> | undefined;
  /** Current value on the pane's Y-domain, or null to hide the line. */
  price: number | null;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  lineStyle: LineStyle;
  /** Master visibility. When false the line stays created but hidden — avoids
   *  churning the handle on a toggle flip. */
  enabled: boolean;
};

/**
 * One native `IPriceLine` on a pane's primary series that tracks a live value
 * (총잔량 매수/매도, 호가비 등). Mirrors LiveCurrentPriceLine's create-once /
 * update-on-primitive-deps split so an SSE tick (which churns the bundle
 * identity) never re-creates the handle — only the value/style flow through
 * the update effect. The pane's own `priceFormat` drives the y-axis tag, so the
 * label reads in the pane's units (잔량 count / imbalance ratio) automatically.
 */
export default function SeriesLevelLine({ series, price, color, lineWidth, lineStyle, enabled }: Props) {
  const lineRef = useRef<IPriceLine | null>(null);

  // Create once per series handle. Starts hidden; the update effect reveals it
  // when enabled + price is available. `as PriceLineOptions`: lightweight-charts
  // marks some fields required though the runtime treats them optional
  // (선례 chart/util/zeroBaseline.ts, LiveCurrentPriceLine.tsx).
  useEffect(() => {
    if (!series) return;
    const line = series.createPriceLine({
      price: 0,
      color,
      lineWidth,
      lineStyle: toLwcLineStyle(lineStyle),
      lineVisible: false,
      axisLabelVisible: false,
      axisLabelColor: color,
      title: '',
    } as PriceLineOptions);
    lineRef.current = line;
    return () => {
      try { series.removePriceLine(line); } catch { /* chart already torn down */ }
      lineRef.current = null;
    };
    // Only the series handle drives (re)creation — style/price flow via the
    // update effect. Matches LiveCurrentPriceLine's intentional split.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  const show = enabled && price != null;
  useEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    if (!show || price == null) {
      line.applyOptions({ lineVisible: false, axisLabelVisible: false });
      return;
    }
    line.applyOptions({
      price,
      color,
      lineWidth,
      lineStyle: toLwcLineStyle(lineStyle),
      axisLabelColor: color,
      lineVisible: true,
      axisLabelVisible: true,
    });
  }, [show, price, color, lineWidth, lineStyle]);

  return null;
}
