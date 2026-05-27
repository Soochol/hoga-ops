import { useEffect, useRef } from 'react';
import {
  createChart,
  LineSeries,
  HistogramSeries,
  type IChartApi,
} from 'lightweight-charts';
import { resolveTokens } from '../util/tokens';
import {
  CHART_CROSSHAIR_OPTIONS,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';

/**
 * Live indicator chart — three sub-panes stacked:
 *   1. Quote Totals: bid_total + ask_total as two lines
 *   2. 호가비 (ratio): single line, signed
 *   3. FillStrength: buy_qty + sell_qty as histograms
 *
 * Stage 9-γ: series mount with empty data. Stage 10 fills them via SSE.
 *
 * Empty-data policy (Addendum 9.4):
 *   - D/W timeframe: pane mounts, series get empty arrays, small header
 *     note "라이브 지표는 분봉에서 표시됩니다".
 *   - Minute timeframes with no data for day: same — pane mounts, empty series.
 *   - Minute timeframes with partial gaps: lightweight-charts whitespaceData
 *     breaks the line at the gap.
 */

const TOKEN_SPEC = {
  bgCard: ['--bg-card', '#13131C'],
  fg: ['--fg', '#E2E8F0'],
  grid: ['--grid', '#1A1A26'],
  border: ['--border', '#1F1F2A'],
  priceUp: ['--price-up', '#DC2626'],
  priceDown: ['--price-down', '#2563EB'],
  accent: ['--accent', '#14B8A6'],
} as const;

interface Props {
  timeframe: string;
}

function isDailyOrWeekly(tf: string): boolean {
  return tf === 'D' || tf === 'W';
}

export function LiveIndicatorPane({ timeframe }: Props) {
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
      layout: { background: { color: tokens.bgCard }, textColor: tokens.fg },
      grid: { vertLines: { color: tokens.grid }, horzLines: { color: tokens.grid } },
      timeScale: CHART_TIMESCALE_OPTIONS,
      crosshair: CHART_CROSSHAIR_OPTIONS,
    });
    chartRef.current = chart;

    // Quote Totals — two LineSeries on pane 0 (default)
    chart.addSeries(LineSeries, { color: tokens.priceUp, lineWidth: 2 });   // ask_total
    chart.addSeries(LineSeries, { color: tokens.priceDown, lineWidth: 2 }); // bid_total

    // 호가비 — one LineSeries
    // NOTE: lightweight-charts v5 supports multi-pane via `addSeries(..., paneIndex)`.
    // Physical pane separation is a Stage 10 polish item; for Stage 9-γ all
    // series live on pane 0. The goal is "panes mount with empty series".
    chart.addSeries(LineSeries, { color: tokens.accent, lineWidth: 2 });

    // FillStrength — two HistogramSeries
    chart.addSeries(HistogramSeries, { color: tokens.priceUp });   // buy_qty
    chart.addSeries(HistogramSeries, { color: tokens.priceDown }); // sell_qty

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dwDisabled = isDailyOrWeekly(timeframe);

  return (
    <div
      data-testid="live-indicator-pane"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: '300px',
        background: 'var(--bg-card)',
      }}
    >
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%' }}
      />
      {dwDisabled && (
        <div
          data-testid="indicator-disabled-note"
          style={{
            position: 'absolute',
            top: 'var(--space-md)',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: 'var(--space-xs) var(--space-md)',
            background: 'var(--bg-subtle)',
            color: 'var(--fg-dimmer)',
            fontSize: 'var(--text-xs)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            pointerEvents: 'none',
          }}
        >
          라이브 지표는 분봉에서 표시됩니다
        </div>
      )}
    </div>
  );
}
