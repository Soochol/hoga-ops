type TimedBar = { t_ms: number };
type LogicalRange = { from: number; to: number };

export type SecondChartViewport = {
  anchorMs: number;
  rightOffset: number;
  span: number;
  barSpacing: number;
};

/** Anchor the right edge to an observed candle, including fractional/empty space. */
export function captureSecondViewport(bars: readonly TimedBar[], range: LogicalRange | null, barSpacing: number): SecondChartViewport | null {
  if (!bars.length || !range) return null;
  const index = Math.max(0, Math.min(bars.length - 1, Math.floor(range.to)));
  return { anchorMs: bars[index].t_ms, rightOffset: range.to - index, span: range.to - range.from, barSpacing };
}

/** Keep zoom while moving a removed anchor to the preceding remaining candle. */
export function restoreSecondViewport(bars: readonly TimedBar[], viewport: SecondChartViewport): LogicalRange {
  let low = 0, high = bars.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (bars[mid].t_ms <= viewport.anchorMs) low = mid + 1;
    else high = mid;
  }
  const to = Math.max(0, low - 1) + viewport.rightOffset;
  return { from: to - viewport.span, to };
}
