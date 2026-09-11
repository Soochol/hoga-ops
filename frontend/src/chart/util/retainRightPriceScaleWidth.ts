import type { IChartApi } from 'lightweight-charts';

/**
 * Keep the widest right axis for this chart instance. Otherwise a digit boundary
 * can alternate between two layouts: a wider axis excludes the leftmost bar,
 * its removal changes volume autoscale, and a narrower axis includes it again.
 * A new chart (symbol/timeframe change) starts with a fresh width budget.
 */
export function retainRightPriceScaleWidth(chart: IChartApi): () => void {
  const timeScale = chart.timeScale();
  let minimumWidth = chart.options().rightPriceScale.minimumWidth;
  let widest = minimumWidth;
  let frame: number | null = null;

  const observe = () => {
    // Capture synchronously: another layout in this frame may already shrink
    // the axis. Only the option write is deferred, outside lwc's layout stack.
    widest = Math.max(widest, chart.priceScale('right').width());
    if (widest <= minimumWidth || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      minimumWidth = widest;
      chart.applyOptions({ rightPriceScale: { minimumWidth } });
    });
  };

  timeScale.subscribeSizeChange(observe);
  observe();
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    timeScale.unsubscribeSizeChange(observe);
  };
}
