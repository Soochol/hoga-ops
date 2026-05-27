import { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { resolveTokens } from '../util/tokens';
import {
  CHART_CROSSHAIR_OPTIONS,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';
import { useLiveCandles } from '../api/liveCandles';

const TOKEN_SPEC = {
  bgCard: ['--bg-card', '#13131C'],
  fg: ['--fg', '#E2E8F0'],
  grid: ['--grid', '#1A1A26'],
  border: ['--border', '#1F1F2A'],
  priceUp: ['--price-up', '#DC2626'],
  priceDown: ['--price-down', '#2563EB'],
} as const;

interface Props {
  code: string | null;
  timeframe: string;
}

export function LiveCandlePane({ code, timeframe }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  // Mount chart once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const tokens = resolveTokens(TOKEN_SPEC);
    const chart = createChart(el, {
      ...CHART_LAYOUT_OPTIONS,
      width: el.clientWidth,
      height: el.clientHeight,
      layout: { background: { color: tokens.bgCard }, textColor: tokens.fg },
      grid: { vertLines: { color: tokens.grid }, horzLines: { color: tokens.grid } },
      timeScale: CHART_TIMESCALE_OPTIONS,
      crosshair: CHART_CROSSHAIR_OPTIONS,
    });
    chartRef.current = chart;
    candleSeriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: tokens.priceUp,
      downColor: tokens.priceDown,
      borderUpColor: tokens.priceUp,
      borderDownColor: tokens.priceDown,
      wickUpColor: tokens.priceUp,
      wickDownColor: tokens.priceDown,
    });
    volumeSeriesRef.current = chart.addSeries(HistogramSeries, {
      priceScaleId: '',
      priceFormat: { type: 'volume' },
    });

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) chart.resize(w, h);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Fetch + push data into series.
  const { data } = useLiveCandles(code ?? '', timeframe);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart || !data) return;
    // KIS endpoints return candles in DESCENDING order (most recent first).
    // lightweight-charts requires strictly-ascending unique timestamps —
    // sort + dedup by time before setData or the series throws and
    // unmounts the entire pane (was the cause of the blank-screen QA bug).
    const seen = new Set<number>();
    const sorted = [...data.candles].sort((a, b) => a.t_ms - b.t_ms);
    const candles: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }> = [];
    const volumes: Array<{ time: UTCTimestamp; value: number }> = [];
    for (const c of sorted) {
      const time = Math.floor(c.t_ms / 1000);
      if (seen.has(time)) continue;
      seen.add(time);
      candles.push({
        time: time as UTCTimestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
      });
      volumes.push({ time: time as UTCTimestamp, value: c.volume });
    }
    candleSeries.setData(candles);
    volumeSeries.setData(volumes);
    // Design B5: keep the chart visually tracking new data.
    chart.timeScale().scrollToRealTime();
  }, [data]);

  return (
    <div
      data-testid="live-candle-pane"
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        // No minHeight — the parent grid row controls height via minmax(0, 1fr).
        // A minHeight here would push the grid track past the workarea bounds.
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
      }}
    />
  );
}
