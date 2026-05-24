import type { ISeriesApi, PriceLineOptions, SeriesType } from 'lightweight-charts';

/**
 * Attach a horizontal 0-price reference line to a chart series — the visual
 * "Zero Baseline Guide" shared by panes whose data straddles zero and whose
 * cross-zero moment is itself the signal (sign-flip = polarity reversal).
 *
 * Currently consumed by:
 *   - RatioPane (호가비) — BaselineSeries switches color at baseValue but
 *     does not draw a visible line there.
 *   - FillStrength pane's Cumulative Net Fill (체결강도 누적) line — the
 *     0-crossing is the buy/sell-cumulative-pressure transition point.
 *
 * Both prior call sites used a byte-identical `series.createPriceLine({...})`
 * block; this helper concentrates the visual contract (dotted, 1px, neutral,
 * no axis label, no title) so a future style change lands in one place. The
 * `as PriceLineOptions` cast is preserved here because lightweight-charts'
 * `PriceLineOptions` includes fields (`lineVisible`) that the runtime treats
 * as optional but the type declares required.
 */
export function addZeroBaselineGuide(series: ISeriesApi<SeriesType>, color: string): void {
  series.createPriceLine({
    price: 0,
    color,
    lineWidth: 1,
    lineStyle: 1, // dotted
    axisLabelVisible: false,
    title: '',
  } as PriceLineOptions);
}
