import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  createChart,
  TickMarkType,
  type IChartApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { type VirtualAxis } from '../util/virtualAxis';
import { resolveTokens } from '../util/tokens';
import {
  CHART_CROSSHAIR_OPTIONS,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';
import { useViewportStore } from '../state/viewport';
import { useTabsStore } from '../state/tabs';
import CandlePane from './CandlePane';
import VolumePane from './VolumePane';
import RatioPane from './RatioPane';
import QuoteTotalsPane from './QuoteTotalsPane';
import FillStrengthPane from './FillStrengthPane';
import VolumeProfileOverlay from './VolumeProfileOverlay';
import DayBoundaryOverlay from './DayBoundaryOverlay';
import { ChartPrefsProvider } from './ChartPrefsContext';

const CHART_TOKEN_SPEC = {
  bgCard: ['--bg-card', '#13131C'],
  fg: ['--fg', '#E2E8F0'],
  grid: ['--grid', '#1A1A26'],
  border: ['--border', '#1F1F2A'],
} as const;

export type ChartStageProps = {
  /**
   * The full range payload (candles, ratio series, intensity matrix, fill
   * strength, etc.) for the Stock-Date Range (ADR-0013). When `null`
   * (loading / error), no panes mount and the stage shows only the bare
   * chart chrome.
   */
  bundle: RangeBundle | null;
  /**
   * Stitched Virtual Axis for the multi-day timeline (Task 6.1). Each pane
   * converts real-ms data to the virtual axis through this object's methods.
   * Construct once via `createVirtualAxis(...)` and pass down; the methods are
   * frozen so identity-based memoisation in children stays cheap.
   */
  axis: VirtualAxis;
};

/**
 * ChartStage — owns the single `lightweight-charts` instance for the replay
 * viewer and mounts the 5 pane children (candles / volume / ratio /
 * quote-totals / fill-strength) plus the VolumeProfileOverlay once the
 * chart is ready and a `RangeBundle` is available.
 *
 * Multi-pane split: each pane component receives a `paneIndex` so its series
 * register on a distinct lightweight-charts pane. Pane heights are set via
 * `IPaneApi.setStretchFactor` after mount with the ratios from DESIGN.md /
 * spec §6.3:
 *   - Pane 0: Candle (1.4) + VolumeProfileOverlay
 *   - Pane 1: Volume (0.3)
 *   - Pane 2: Ratio (0.4)
 *   - Pane 3: Quote Totals (0.4) — bid/ask 1–10호가 total LineSeries
 *   - Pane 4: FillStrength (0.4)
 *
 * Viewport publisher: subscribes to the chart's visible-range and writes
 * (fromMs, toMs) into `useViewportStore` so sibling components like
 * PriceStrip can read viewport state without prop-drilling (Task 6.5).
 */
/**
 * Pane stretch factors (DESIGN.md / spec §6.3). Indexes:
 *   0 = candle, 1 = volume, 2 = ratio, 3 = quote-totals, 4 = fill-strength.
 * Total = 2.9; lightweight-charts treats these as proportional weights.
 * Candle share rises ~42% → ~48% vs the prior heatmap layout — intentional;
 * two lines do not need the vertical budget the heatmap consumed.
 */
const PANE_STRETCH = [1.4, 0.3, 0.4, 0.4, 0.4] as const;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export default function ChartStage({ bundle, axis }: ChartStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);
  // Single per-tab ChartViewPrefs subscription. Distributed to descendant
  // panes via ChartPrefsProvider so each pane reads through useChartPrefs()
  // without re-subscribing to the store. Toggling any pref in the Settings
  // modal re-renders ChartStage and propagates fresh prefs down the tree.
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const prefs = useTabsStore((s) => s.getPrefs(activeTabId));
  // Keep the latest axis visible to the once-mounted subscribeVisibleTimeRange
  // handler. lightweight-charts emits times on our VIRTUAL axis (Task 6.1);
  // viewport consumers need REAL Unix-ms, so the handler reads this ref and
  // converts via axis.toReal.
  const axisRef: MutableRefObject<VirtualAxis> = useRef<VirtualAxis>(axis);
  useEffect(() => {
    axisRef.current = axis;
  }, [axis]);

  useEffect(() => {
    if (!containerRef.current) return;
    const tokens = resolveTokens(CHART_TOKEN_SPEC);

    const c = createChart(containerRef.current, {
      layout: {
        ...CHART_LAYOUT_OPTIONS,
        background: { color: tokens.bgCard },
        textColor: tokens.fg,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: tokens.grid },
        horzLines: { color: tokens.grid },
      },
      crosshair: CHART_CROSSHAIR_OPTIONS,
      localization: {
        // Crosshair floating label sits on a different code path than
        // tickMarkFormatter below: the library reads `localization.timeFormatter`
        // when rendering the time chip that follows the cursor on the x-axis.
        // Without this, our virtual-axis values get decoded as Unix-epoch
        // seconds and the chip reads "02 1월'70 03:26" et al.
        timeFormatter: (time: Time): string => {
          const virtualMs = (time as number) * 1000;
          const a = axisRef.current;
          if (a.segments.length === 0) return '';
          const realMs = a.toReal(virtualMs);
          const d = new Date(realMs + 9 * 3600_000); // KST = UTC + 9h
          return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        },
      },
      timeScale: {
        ...CHART_TIMESCALE_OPTIONS,
        timeVisible: true,
        secondsVisible: false,
        borderColor: tokens.border,
        // lightweight-charts treats time-axis values as raw Unix seconds
        // offsets from the epoch. We use a stitched virtual axis
        // (util/time.ts) where virtual-ms is offset from
        // segments[0].sessionOpenMs, not from epoch — so the library's
        // default labels would be meaningless ("1970-01-01 + virtualMs").
        // This formatter converts back to real Unix-ms via virtualToReal and
        // formats in KST (UTC+9). See spec §6.6(b) "Virtual Axis Label
        // formatting" and replay-zoom-density plan Task 17c.
        tickMarkFormatter: (time: UTCTimestamp, tickType: TickMarkType): string => {
          const virtualMs = (time as number) * 1000;
          const a = axisRef.current;
          if (a.segments.length === 0) return '';
          const realMs = a.toReal(virtualMs);
          const d = new Date(realMs + 9 * 3600_000); // KST = UTC + 9h
          switch (tickType) {
            case TickMarkType.Year:
            case TickMarkType.Month:
            case TickMarkType.DayOfMonth:
              return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
            case TickMarkType.Time:
              return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
            case TickMarkType.TimeWithSeconds:
              return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
            default:
              return '';
          }
        },
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
      const a = axisRef.current;
      const toReal = (sec: number | null | undefined) => {
        if (sec == null) return null;
        const virtualMs = sec * 1000;
        return a.segments.length === 0 ? null : a.toReal(virtualMs);
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

  // Initial fit-to-data + zoom clamps. Fires when the chart becomes ready and
  // a bundle is available. Without `fitContent`, lightweight-charts leaves
  // the visible range at its default barSpacing, which over-zooms on small
  // ranges and under-zooms on multi-day ranges.
  // Clamp invariants:
  //   - Logical range can never exceed total bar count (no infinite zoom-out).
  //   - barSpacing capped at 50 (no extreme zoom-in past one bar per ~50 px).
  // See spec §6.6(a) "Zoom Density" / replay-zoom-density plan Task 17b.
  useEffect(() => {
    if (!chart || !bundle) return;
    const ts = chart.timeScale();
    ts.fitContent();
    const totalBars = bundle.candles.length;
    const handler = (range: { from: number; to: number } | null) => {
      if (!range) return;
      const len = range.to - range.from;
      if (len > totalBars) {
        ts.setVisibleLogicalRange({ from: 0, to: totalBars });
        return;
      }
      const bs = ts.options().barSpacing;
      if (typeof bs === 'number' && bs > 50) {
        ts.applyOptions({ barSpacing: 50 });
      }
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => ts.unsubscribeVisibleLogicalRangeChange(handler);
  }, [chart, bundle]);

  return (
    <div className="relative h-full min-h-0 bg-bg-card">
      <div ref={containerRef} className="absolute inset-0" />
      {chart && bundle && (
        <ChartPrefsProvider value={prefs}>
          {/*
            Series-only panes return null after registering their series on
            the chart. The wrapping `data-pane` divs are `hidden` so they
            don't occupy layout space but remain selectable by E2E specs
            asserting "pane was mounted".
          */}
          <div data-pane="candle" className="hidden">
            <CandlePane chart={chart} bundle={bundle} axis={axis} paneIndex={0} />
          </div>
          <div data-pane="volume" className="hidden">
            <VolumePane chart={chart} bundle={bundle} axis={axis} paneIndex={1} />
          </div>
          <div data-pane="ratio" className="hidden">
            <RatioPane chart={chart} bundle={bundle} axis={axis} paneIndex={2} />
          </div>
          {/*
            Render order must match paneIndex order. lightweight-charts v5
            does not auto-create intermediate panes: `addSeries(...,
            paneIndex=4)` while only panes 0-2 exist lands the first series
            on pane 3 (next available index), not pane 4. Mounting
            FillStrengthPane before QuoteTotalsPane therefore splits its
            buy/sell histograms across pane 3 (Quote Totals slot) and pane 4.
            QuoteTotalsPane's two LineSeries claim pane 3 first so
            FillStrengthPane's pair both land on 4.

            VolumeProfileOverlay below is still a canvas-overlay pane portaled
            into its target pane's DOM via `chart.panes()[0].getHTMLElement()`;
            the `data-pane` wrapper is kept for E2E selectors but no longer
            hosts the canvas itself.
          */}
          <div data-pane="quote-totals" className="hidden">
            <QuoteTotalsPane chart={chart} bundle={bundle} axis={axis} paneIndex={3} />
          </div>
          <div data-pane="fill-strength" className="hidden">
            <FillStrengthPane chart={chart} bundle={bundle} axis={axis} paneIndex={4} />
          </div>
          <div data-pane="volume-profile" className="hidden">
            <VolumeProfileOverlay
              chart={chart}
              bundle={bundle}
              axis={axis}
              paneIndex={0}
            />
          </div>
          {/*
            Day Boundary overlay (Task 18). Vertical line + MM/DD chip at each
            segment boundary. pointer-events-none so it doesn't interfere with
            chart crosshair interaction.
          */}
          <DayBoundaryOverlay chart={chart} axis={axis} />
        </ChartPrefsProvider>
      )}
    </div>
  );
}
