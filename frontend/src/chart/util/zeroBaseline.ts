import type {
  AutoscaleInfoProvider,
  ISeriesApi,
  PriceLineOptions,
  SeriesType,
} from 'lightweight-charts';

/**
 * Attach a horizontal 0-price reference line to a chart series — the visual
 * "Zero Baseline Guide" shared by panes whose data straddles zero and whose
 * cross-zero moment is itself the signal (sign-flip = polarity reversal).
 *
 * Currently consumed by:
 *   - RatioPane (호가비) — BaselineSeries switches color at baseValue but
 *     does not draw a visible line there.
 *   - Volume pane's Cumulative line (거래량 누적) and FillStrength pane's
 *     Cumulative Net Fill (체결강도 누적) — the 0-crossing is the
 *     buy/sell-cumulative-pressure transition point.
 *   - ProgramTrade pane (프로그램 순매수) — `net_amount` is the signed
 *     daily-cumulative program net buy, so 0 is 매수/매도 우위의 경계다.
 *
 * The prior call sites used a byte-identical `series.createPriceLine({...})`
 * block; this helper concentrates the visual contract (dotted, 1px, neutral,
 * no axis label, no title) so a future style change lands in one place. The
 * `as PriceLineOptions` cast is preserved here because lightweight-charts'
 * `PriceLineOptions` includes fields (`lineVisible`) that the runtime treats
 * as optional but the type declares required.
 *
 * A price line alone is NOT enough to keep the guide on screen — see
 * {@link includeZeroAutoscale}.
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

/** Degenerate-range padding: applied only when the merged range collapses to
 *  min === max (a flat all-zero window), which would otherwise give lwc a
 *  zero-height price range. Sized for 호가비's ±1.x magnitudes; at 억원
 *  magnitudes (프로그램 순매수) it is far below one pixel, so it stays a
 *  no-op outside that degenerate case. */
const ZERO_AUTOSCALE_EPSILON = 0.01;

/**
 * Merge 0 into a series' autoscaled price range so {@link addZeroBaselineGuide}'s
 * line stays inside the pane.
 *
 * Why it's needed: lightweight-charts autoscales the **visible** range, not the
 * whole dataset. A pane whose data is one-sided in that window (호가비's
 * one-sided runs in a study snapshot; 프로그램 순매수's daily-cumulative value
 * after a session that only ever bought) gets a range that excludes 0 — and the
 * reference line silently leaves the viewport at exactly the moment the reader
 * needs it to judge sign.
 *
 * Cost of using it: the scale is stretched to reach 0, so a +200억~+300억 window
 * renders as 0~300억 and intraday detail compresses. That's the deliberate
 * trade — panes where the sign is the point take it, panes where magnitude
 * detail is the point should not.
 *
 * BaselineSeries has a second, harder requirement: its `relativeGradient` stops
 * are computed against the baseline's position in the range, so an excluded 0
 * makes them non-finite. That's why RatioPane cannot opt out.
 */
export const includeZeroAutoscale: AutoscaleInfoProvider = (original) => {
  const res = original();
  if (!res?.priceRange) return res;
  res.priceRange.minValue = Math.min(res.priceRange.minValue, 0);
  res.priceRange.maxValue = Math.max(res.priceRange.maxValue, 0);
  if (res.priceRange.minValue === res.priceRange.maxValue) {
    res.priceRange.minValue -= ZERO_AUTOSCALE_EPSILON;
    res.priceRange.maxValue += ZERO_AUTOSCALE_EPSILON;
  }
  return res;
};
