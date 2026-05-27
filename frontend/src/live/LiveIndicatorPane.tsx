import { useEffect, useRef } from 'react';
import {
  createChart,
  LineSeries,
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
import { useLiveSeries } from '../api/liveSeries';

/**
 * Live indicator chart — three sub-panes stacked:
 *   1. Quote Totals: bid_total + ask_total as two lines
 *   2. 호가비 (ratio): single line, signed
 *   3. FillStrength: buy_qty + sell_qty as histograms
 *
 * Stage 10: series are wired to live data via useLiveSeries (initial REST + SSE).
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
  priceUp: ['--price-up', '#DC2626'],
  priceDown: ['--price-down', '#2563EB'],
  accent: ['--accent', '#14B8A6'],
} as const;

interface Props {
  code: string | null;
  timeframe: string;
}

function isDailyOrWeekly(tf: string): boolean {
  return tf === 'D' || tf === 'W';
}

export function LiveIndicatorPane({ code, timeframe }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const askTotalRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bidTotalRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ratioRef = useRef<ISeriesApi<'Line'> | null>(null);
  const buyQtyRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const sellQtyRef = useRef<ISeriesApi<'Histogram'> | null>(null);

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
    askTotalRef.current = chart.addSeries(LineSeries, { color: tokens.priceUp, lineWidth: 2 });
    bidTotalRef.current = chart.addSeries(LineSeries, { color: tokens.priceDown, lineWidth: 2 });
    ratioRef.current = chart.addSeries(LineSeries, { color: tokens.accent, lineWidth: 2 });
    buyQtyRef.current = chart.addSeries(HistogramSeries, { color: tokens.priceUp });
    sellQtyRef.current = chart.addSeries(HistogramSeries, { color: tokens.priceDown });

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
      askTotalRef.current = null;
      bidTotalRef.current = null;
      ratioRef.current = null;
      buyQtyRef.current = null;
      sellQtyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to live series (initial REST + SSE).
  const { ob, trade } = useLiveSeries(code ?? '');

  // D/W: per Addendum 9.4, panes mount with empty series.
  const dwDisabled = isDailyOrWeekly(timeframe);

  useEffect(() => {
    const chart = chartRef.current;
    const askS = askTotalRef.current;
    const bidS = bidTotalRef.current;
    const ratioS = ratioRef.current;
    const buyS = buyQtyRef.current;
    const sellS = sellQtyRef.current;
    if (!chart || !askS || !bidS || !ratioS || !buyS || !sellS) return;

    if (dwDisabled || !code) {
      askS.setData([]);
      bidS.setData([]);
      ratioS.setData([]);
      buyS.setData([]);
      sellS.setData([]);
      return;
    }

    // Quote Totals (from ob snapshots)
    const asks = ob.map((o) => ({
      time: Math.floor((o.t_ms as number) / 1000) as UTCTimestamp,
      value: (o.total_ask_qty as number) ?? 0,
    }));
    const bids = ob.map((o) => ({
      time: Math.floor((o.t_ms as number) / 1000) as UTCTimestamp,
      value: (o.total_bid_qty as number) ?? 0,
    }));
    askS.setData(asks);
    bidS.setData(bids);

    // 호가비 = (ask - bid) / (ask + bid), signed
    const ratios = ob.map((o) => {
      const a = (o.total_ask_qty as number) ?? 0;
      const b = (o.total_bid_qty as number) ?? 0;
      const denom = a + b || 1;
      return {
        time: Math.floor((o.t_ms as number) / 1000) as UTCTimestamp,
        value: (a - b) / denom,
      };
    });
    ratioS.setData(ratios);

    // FillStrength from trade snapshots — sum buy vs sell qty per bucket
    const buy: Array<{ time: UTCTimestamp; value: number }> = [];
    const sell: Array<{ time: UTCTimestamp; value: number }> = [];
    for (const t of trade) {
      const time = Math.floor((t.t_ms as number) / 1000) as UTCTimestamp;
      const trades = (t.trades as Array<{ side: number; qty: number }>) ?? [];
      let buyQty = 0;
      let sellQty = 0;
      for (const x of trades) {
        if (x.side === 1) buyQty += x.qty;
        else if (x.side === -1) sellQty += x.qty;
      }
      buy.push({ time, value: buyQty });
      sell.push({ time, value: sellQty });
    }
    buyS.setData(buy);
    sellS.setData(sell);

    chart.timeScale().scrollToRealTime();
  }, [ob, trade, code, dwDisabled]);

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
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
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
