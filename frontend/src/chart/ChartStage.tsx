import { useEffect, useRef, useState } from 'react';
import { createChart, type IChartApi } from 'lightweight-charts';
import type { SessionBundle } from '../api/types';
import type { Segment } from '../util/time';
import { useViewportStore } from '../state/viewport';
import CandlePane from './CandlePane';
import VolumePane from './VolumePane';
import RatioPane from './RatioPane';
import IntensityPane from './IntensityPane';
import FillStrengthPane from './FillStrengthPane';
import VolumeProfileOverlay from './VolumeProfileOverlay';

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

export type ChartStageProps = {
  /**
   * The full session payload (candles, ratio series, intensity matrix, fill
   * strength, etc.). When `null` (loading / error), no panes mount and the
   * stage shows only the bare chart chrome.
   */
  bundle: SessionBundle | null;
  /**
   * Stitched time-axis segments for the multi-day virtual timeline (Task 6.1).
   * Each pane converts real-ms data to the virtual axis using these.
   */
  segments: Segment[];
};

/**
 * ChartStage — owns the single `lightweight-charts` instance for the replay
 * viewer and mounts the 5 pane children (candles / volume / ratio / intensity
 * / fill-strength) plus the VolumeProfileOverlay once the chart is ready and
 * a `SessionBundle` is available.
 *
 * Single-pane MVP: all 5 series-based panes currently register on
 * lightweight-charts pane 0. Multi-pane split via `addSeries(..., paneIndex)`
 * is a follow-up (see plan Phase 7+). The `data-pane="…"` wrappers exist so
 * E2E selectors can verify each pane has mounted independently of the
 * underlying canvas layout.
 *
 * Viewport publisher: subscribes to the chart's visible-range and writes
 * (fromMs, toMs) into `useViewportStore` so sibling components like
 * PriceStrip can read viewport state without prop-drilling (Task 6.5).
 */
export default function ChartStage({ bundle, segments }: ChartStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const tokens = resolveTokens();

    const c = createChart(containerRef.current, {
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
    setChart(c);

    // Wire visible-range subscription. The chart emits ranges as
    // { from, to } in UTCTimestamp (seconds); convert to ms for the rest
    // of the app.
    const ts = c.timeScale();
    const handler = (range: unknown) => {
      const r = range as { from?: number | null; to?: number | null } | null;
      const fromMs = r?.from != null ? r.from * 1000 : null;
      const toMs = r?.to != null ? r.to * 1000 : null;
      // Publish to the viewport store so sibling components (PriceStrip,
      // Task 6.5) can subscribe without prop-drilling.
      useViewportStore.getState().set(fromMs, toMs);
    };
    ts.subscribeVisibleTimeRangeChange(handler);

    return () => {
      ts.unsubscribeVisibleTimeRangeChange(handler);
      c.remove();
      setChart(null);
      useViewportStore.getState().reset();
    };
    // The chart is mounted exactly once. Re-creating it on every prop
    // identity change would tear down panes / series added by the children.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative h-full min-h-0 bg-bg-card">
      <div ref={containerRef} className="absolute inset-0" />
      {chart && bundle && (
        <>
          {/*
            Series-only panes return null after registering their series on
            the chart. The wrapping `data-pane` divs are `hidden` so they
            don't occupy layout space but remain selectable by E2E specs
            asserting "pane was mounted".
          */}
          <div data-pane="candle" className="hidden">
            <CandlePane chart={chart} bundle={bundle} segments={segments} />
          </div>
          <div data-pane="volume" className="hidden">
            <VolumePane chart={chart} bundle={bundle} segments={segments} />
          </div>
          <div data-pane="ratio" className="hidden">
            <RatioPane chart={chart} bundle={bundle} segments={segments} />
          </div>
          <div data-pane="fill-strength" className="hidden">
            <FillStrengthPane chart={chart} bundle={bundle} segments={segments} />
          </div>
          {/*
            Canvas overlay panes — paint absolutely on top of the chart
            container. `pointer-events-none` lets crosshair / drag interactions
            pass through to lightweight-charts underneath.
          */}
          <div data-pane="intensity" className="absolute inset-0 pointer-events-none">
            <IntensityPane chart={chart} bundle={bundle} segments={segments} />
          </div>
          <div data-pane="volume-profile" className="absolute inset-0 pointer-events-none">
            <VolumeProfileOverlay
              chart={chart}
              bundle={bundle}
              segments={segments}
              mode="composite"
            />
          </div>
        </>
      )}
    </div>
  );
}
