import { useEffect, useRef, useState } from 'react';
import { createChart, type IChartApi } from 'lightweight-charts';

export type ChartStageProps = {
  /**
   * Notified when the chart instance is created. Phase 7 panes will use this
   * to add their series to the right paneIndex.
   */
  onReady?: (chart: IChartApi) => void;
  /**
   * Notified when the visible time range changes. Task 6.5 (PriceStrip
   * viewport tracking) will subscribe via this.
   *
   * Values are Unix milliseconds (the app-wide convention). The chart's
   * internal time axis uses UTCTimestamp seconds; we convert here so
   * consumers don't have to.
   */
  onVisibleRangeChange?: (from: number | null, to: number | null) => void;
};

/**
 * Resolves a CSS custom property from `:root` to a concrete string value
 * (e.g. "#13131C"). lightweight-charts paints to a canvas, which can't
 * interpret CSS variables — so we resolve the design tokens at chart-create
 * time. Tokens are defined in `src/styles/tokens.css`.
 */
function resolveTokens() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    // SSR / non-DOM safety net. The chart only constructs in the browser,
    // but TS doesn't know that.
    return { bgCard: '#13131C', fg: '#E2E8F0', grid: '#1A1A26', border: '#1F1F2A' };
  }
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => {
    const raw = cs.getPropertyValue(name).trim();
    return raw.length > 0 ? raw : fallback;
  };
  return {
    bgCard: v('--bg-card', '#13131C'),
    fg: v('--fg', '#E2E8F0'),
    grid: v('--grid', '#1A1A26'),
    border: v('--border', '#1F1F2A'),
  };
}

/**
 * ChartStage — owns the single `lightweight-charts` instance for the replay
 * viewer and lays out the 5-pane grid (candles / volume / ratio / intensity /
 * fill-strength). Pane content is filled in Phase 7; this scaffold brings the
 * chart instance up and wires the visible-range subscription that
 * Task 6.5 (PriceStrip viewport tracking) will hook into.
 *
 * Multi-day data is stitched on the chart's time axis (Task 6.1).
 */
export default function ChartStage({ onReady, onVisibleRangeChange }: ChartStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const tokens = resolveTokens();

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: tokens.bgCard },
        textColor: tokens.fg,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: tokens.grid },
        horzLines: { color: tokens.grid },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: tokens.border,
      },
      rightPriceScale: { borderColor: tokens.border },
      autoSize: true,
    });
    chartRef.current = chart;
    setReady(true);
    onReady?.(chart);

    // Wire visible-range subscription. The chart emits ranges as
    // { from, to } in UTCTimestamp (seconds); convert to ms for the rest
    // of the app.
    const ts = chart.timeScale();
    const handler = (range: unknown) => {
      if (!onVisibleRangeChange) return;
      const r = range as { from?: number | null; to?: number | null } | null;
      if (!r) {
        onVisibleRangeChange(null, null);
        return;
      }
      onVisibleRangeChange(
        r.from != null ? r.from * 1000 : null,
        r.to != null ? r.to * 1000 : null,
      );
    };
    ts.subscribeVisibleTimeRangeChange(handler);

    return () => {
      ts.unsubscribeVisibleTimeRangeChange(handler);
      chart.remove();
      chartRef.current = null;
    };
    // The chart is mounted exactly once. Re-creating it on every prop
    // identity change would tear down panes / series added by Phase 7.
    // Consumers wire callbacks via stable refs upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="grid grid-rows-[1.4fr_0.3fr_0.4fr_0.8fr_0.4fr] h-full min-h-0 gap-2 p-1 bg-bg relative">
      {/*
        Pane slots — Phase 7 will fill these with CandlePane / VolumePane /
        RatioPane / IntensityPane / FillStrengthPane, each mounting to a
        distinct `paneIndex` on the shared chart instance. For now, the
        chart container spans all five rows so the empty stage still
        renders with visible grid/axis chrome.
      */}
      <div ref={containerRef} className="row-span-5 relative" />
      {!ready && (
        <span className="absolute inset-0 grid place-items-center text-fg-dim text-sm">
          차트 준비 중…
        </span>
      )}
    </div>
  );
}
