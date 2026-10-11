import type { IChartApi } from 'lightweight-charts';

/** 추가된 가격선도 캔들 아래에 둔다. series 재생성이나 viewport 변경은 필요 없다. */
export function keepCandlesOnTop(chart: IChartApi): void {
  const series = chart.panes()[0]?.getSeries() ?? [];
  const candle = series.find((s) => s.seriesType() === 'Candlestick');
  const top = series.length - 1;
  if (candle && candle.seriesOrder() !== top) candle.setSeriesOrder(top);
}
