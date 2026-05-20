import { useEffect, useRef, useState } from 'react';
import { createChart, type IChartApi } from 'lightweight-charts';
import type { SessionBundle } from '../api/types';
import { type Segment, virtualToReal } from '../util/time';
import { resolveTokens } from '../util/tokens';
import { useViewportStore } from '../state/viewport';
import CandlePane from './CandlePane';
import VolumePane from './VolumePane';
import RatioPane from './RatioPane';
import IntensityPane from './IntensityPane';
import FillStrengthPane from './FillStrengthPane';
import VolumeProfileOverlay from './VolumeProfileOverlay';

const CHART_TOKEN_SPEC = {
  bgCard: ['--bg-card', '#13131C'],
  fg: ['--fg', '#E2E8F0'],
  grid: ['--grid', '#1A1A26'],
  border: ['--border', '#1F1F2A'],
} as const;

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
 * Multi-pane split: each pane component receives a `paneIndex` so its series
 * register on a distinct lightweight-charts pane. Pane heights are set via
 * `IPaneApi.setStretchFactor` after mount with the ratios from DESIGN.md /
 * spec §6.3:
 *   - Pane 0: Candle (1.4) + VolumeProfileOverlay
 *   - Pane 1: Volume (0.3)
 *   - Pane 2: Ratio (0.4)
 *   - Pane 3: Intensity overlay (0.8)
 *   - Pane 4: FillStrength (0.4)
 *
 * IntensityPane has no series of its own (canvas heatmap), so we mount an
 * invisible histogram on pane 3 to force the pane to exist, then portal the
 * canvas into that pane's DOM element via `getHTMLElement()`. The `data-pane`
 * wrappers remain for E2E selectors.
 *
 * Viewport publisher: subscribes to the chart's visible-range and writes
 * (fromMs, toMs) into `useViewportStore` so sibling components like
 * PriceStrip can read viewport state without prop-drilling (Task 6.5).
 */
/**
 * Pane stretch factors (DESIGN.md / spec §6.3). Indexes:
 *   0 = candle, 1 = volume, 2 = ratio, 3 = intensity, 4 = fill-strength.
 * Total = 3.3; lightweight-charts treats these as proportional weights.
 */
const PANE_STRETCH = [1.4, 0.3, 0.4, 0.8, 0.4] as const;

export default function ChartStage({ bundle, segments }: ChartStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);
  // Keep latest segments visible to the once-mounted subscribeVisibleTimeRange
  // handler. lightweight-charts emits times on our VIRTUAL axis (Task 6.1);
  // viewport consumers need REAL Unix-ms, so the handler reads this ref and
  // converts via virtualToReal.
  const segmentsRef = useRef<Segment[]>(segments);
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    if (!containerRef.current) return;
    const tokens = resolveTokens(CHART_TOKEN_SPEC);

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
    // { from, to } in UTCTimestamp (seconds) on the VIRTUAL axis;
    // convert to virtual-ms then to REAL Unix-ms via the active segments
    // before publishing — the rest of the app (PriceStrip, useCursor → spot
    // fetches) expects Unix-ms cursors per ADR 0003.
    const ts = c.timeScale();
    const handler = (range: unknown) => {
      const r = range as { from?: number | null; to?: number | null } | null;
      const segs = segmentsRef.current;
      const toReal = (sec: number | null | undefined) => {
        if (sec == null) return null;
        const virtualMs = sec * 1000;
        return segs.length === 0 ? null : virtualToReal(segs, virtualMs);
      };
      const fromMs = toReal(r?.from);
      const toMs = toReal(r?.to);
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

  // Apply pane stretch factors AFTER the children's effects have run and
  // created panes 0-4 via `addSeries(..., paneIndex)`. rAF lets all child
  // effects flush first; we then size each pane proportionally.
  useEffect(() => {
    if (!chart || !bundle) return;
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      try {
        const panes = chart.panes();
        // If panes haven't materialised yet (race with child mount), retry
        // once on the next frame. After two rAFs everything is settled.
        if (panes.length < PANE_STRETCH.length) {
          requestAnimationFrame(apply);
          return;
        }
        panes.forEach((p, i) => {
          const f = PANE_STRETCH[i];
          if (f !== undefined && typeof p.setStretchFactor === 'function') {
            p.setStretchFactor(f);
          }
        });
      } catch {
        // ignore — chart may be tearing down
      }
    };
    const raf = requestAnimationFrame(apply);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [chart, bundle]);

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
            <CandlePane chart={chart} bundle={bundle} segments={segments} paneIndex={0} />
          </div>
          <div data-pane="volume" className="hidden">
            <VolumePane chart={chart} bundle={bundle} segments={segments} paneIndex={1} />
          </div>
          <div data-pane="ratio" className="hidden">
            <RatioPane chart={chart} bundle={bundle} segments={segments} paneIndex={2} />
          </div>
          <div data-pane="fill-strength" className="hidden">
            <FillStrengthPane chart={chart} bundle={bundle} segments={segments} paneIndex={4} />
          </div>
          {/*
            Canvas overlay panes — portaled into their target pane's DOM
            element via `chart.panes()[paneIndex].getHTMLElement()`. The
            wrappers here are kept for E2E selectors but no longer host the
            canvases themselves (the canvas lives inside the pane element).
          */}
          <div data-pane="intensity" className="hidden">
            <IntensityPane chart={chart} bundle={bundle} segments={segments} paneIndex={3} />
          </div>
          <div data-pane="volume-profile" className="hidden">
            <VolumeProfileOverlay
              chart={chart}
              bundle={bundle}
              segments={segments}
              mode="composite"
              paneIndex={0}
            />
          </div>
        </>
      )}
    </div>
  );
}
