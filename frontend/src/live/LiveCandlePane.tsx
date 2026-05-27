import { useEffect, useRef } from 'react';
import {
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { resolveTokens } from '../util/tokens';
import {
  CHART_CROSSHAIR_OPTIONS,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';

/**
 * Live candle + volume chart.
 *
 * Stage 9-γ: candle and volume series are mounted but data arrays may be
 * empty. Real data flows in Stage 10 via `useLiveCandles`.
 *
 * Empty-data policy (Addendum 9.4): the chart container always mounts.
 * `series.setData([])` shows an empty chart, NOT a hidden pane.
 */

const TOKEN_SPEC = {
  bgCard: ['--bg-card', '#13131C'],
  fg: ['--fg', '#E2E8F0'],
  grid: ['--grid', '#1A1A26'],
  border: ['--border', '#1F1F2A'],
  priceUp: ['--price-up', '#DC2626'],
  priceDown: ['--price-down', '#2563EB'],
} as const;

export interface CandleData {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VolumeBarData {
  time: UTCTimestamp;
  value: number;
  color?: string;
}

interface Props {
  candles?: CandleData[];
  volumes?: VolumeBarData[];
  timeframe: string;
}

export function LiveCandlePane({ candles = [], volumes = [], timeframe: _timeframe }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const tokens = resolveTokens(TOKEN_SPEC);
    const chart = createChart(el, {
      ...CHART_LAYOUT_OPTIONS,
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { color: tokens.bgCard },
        textColor: tokens.fg,
      },
      grid: {
        vertLines: { color: tokens.grid },
        horzLines: { color: tokens.grid },
      },
      timeScale: CHART_TIMESCALE_OPTIONS,
      crosshair: CHART_CROSSHAIR_OPTIONS,
    });
    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: tokens.priceUp,
      downColor: tokens.priceDown,
      borderUpColor: tokens.priceUp,
      borderDownColor: tokens.priceDown,
      wickUpColor: tokens.priceUp,
      wickDownColor: tokens.priceDown,
    });
    const volumeSeries = chart.addHistogramSeries({
      priceScaleId: '',
      priceFormat: { type: 'volume' },
    });
    volumeSeries.applyOptions({
      // Volume series occupies the bottom ~25% of the candle pane.
      // lightweight-charts v4 supports `scaleMargins` on price scale.
    });

    // Initial data load
    if (candles.length > 0) candleSeries.setData(candles as any);
    if (volumes.length > 0) volumeSeries.setData(volumes as any);

    // Resize handler — lightweight-charts doesn't auto-resize
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
    };
    // We intentionally do NOT depend on candles/volumes — data updates
    // come through a separate ref-based effect to avoid tearing down the
    // chart on every prop change. Stage 10 will add that effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      data-testid="live-candle-pane"
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: '300px',
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
      }}
    />
  );
}
