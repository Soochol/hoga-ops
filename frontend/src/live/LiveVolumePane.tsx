import { useEffect, useRef } from 'react';
import {
  createChart,
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
import type { LiveTimeframe } from '../state/livePage';

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
  timeframe: LiveTimeframe;
}

/** Volume histogram split out of LiveCandlePane (user feedback 2026-05-27).
 *
 * Same data source (useLiveCandles) and same x-axis as the candle pane,
 * but rendered in its own chart so the price/volume aspect ratios are
 * independent. Bar color follows candle direction (close >= open → up). */
export function LiveVolumePane({ code, timeframe }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lastFitKeyRef = useRef<string>('');

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
    volumeRef.current = chart.addSeries(HistogramSeries, {
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
      volumeRef.current = null;
    };
  }, []);

  const { candles } = useLiveCandles(code ?? '', timeframe);

  useEffect(() => {
    const series = volumeRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const tokens = resolveTokens(TOKEN_SPEC);
    const seen = new Set<number>();
    const rows: Array<{ time: UTCTimestamp; value: number; color: string }> = [];
    for (const c of candles) {
      const time = Math.floor(c.t_ms / 1000);
      if (seen.has(time)) continue;
      seen.add(time);
      const up = c.close >= c.open;
      rows.push({
        time: time as UTCTimestamp,
        value: c.volume,
        color: up ? tokens.priceUp : tokens.priceDown,
      });
    }
    series.setData(rows);
    const fitKey = `${code ?? ''}|${timeframe}`;
    if (rows.length > 0 && fitKey !== lastFitKeyRef.current) {
      chart.timeScale().fitContent();
      lastFitKeyRef.current = fitKey;
    } else {
      chart.timeScale().scrollToRealTime();
    }
  }, [candles, code, timeframe]);

  return (
    <div
      data-testid="live-volume-pane"
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
      }}
    />
  );
}
