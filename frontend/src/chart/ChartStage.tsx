import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  createChart,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { PaneId, Drawing } from './drawing/types';
import { priceToCanvasY, realMsToCanvasX } from './drawing/chartCoordinates';
import type { RangeBundle } from '../api/types';
import { type VirtualAxis } from '../util/virtualAxis';
import { resolveTokens } from '../util/tokens';
import {
  CHART_CROSSHAIR_OPTIONS,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';
import { computeWheelOutcome } from '../util/wheelInteractions';
import { useViewportStore } from '../state/viewport';
import { useTabsStore } from '../state/tabs';
import RangeSeriesPane from './RangeSeriesPane';
import { PANE_SPECS, PANE_STRETCH } from './paneSpecs';
import { MOVING_AVERAGE_SPEC } from './projectors/movingAverage';
import VolumeProfileOverlay from './VolumeProfileOverlay';
import DayBoundaryOverlay from './DayBoundaryOverlay';
import AuctionWindowOverlay from './AuctionWindowOverlay';
import DrawingOverlay from './DrawingOverlay';
import DrawingPropertyPanel from './DrawingPropertyPanel';
import { useDrawingsStore } from '../state/drawings';

const CHART_TOKEN_SPEC = {
  bgCard: ['--bg-card', '#13131C'],
  fg: ['--fg', '#E2E8F0'],
  grid: ['--grid', '#1A1A26'],
  border: ['--border', '#1F1F2A'],
} as const;

export type ChartStageProps = {
  /**
   * The full range payload for the Stock-Date Range (ADR-0013): candles,
   * `quote_ratio` (carries `bid_total`/`ask_total` totals consumed by both
   * RatioPane and the Quote Totals pane), `fill_strength`, and the
   * `volume_profile_range` / `volume_profile_by_day` series. When `null`
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
 * spec §6.3.
 *   See `paneSpecs.ts` for the canonical pane registry. ChartStage
 *   reads PANE_SPECS in order and mounts one `<RangeSeriesPane spec=...>`
 *   per entry. VolumeProfileOverlay (pane 0 canvas overlay) and
 *   DayBoundaryOverlay (chart-wide) remain hand-mounted alongside.
 *
 * Viewport publisher: subscribes to the chart's visible-range and writes
 * (fromMs, toMs) into `useViewportStore` so sibling components like
 * PriceStrip can read viewport state without prop-drilling (Task 6.5).
 */

const PANEL_Y_OFFSET = -38;
// hline panels return their CONTAINER-CENTER X. The panel renders with
// `transform: translateX(-50%)` for hline kind so the visual centre lands
// on this X. trendline / pencil keep their existing left-aligned offsets.
const PANEL_X_OFFSET_PENCIL = 0;
const PANEL_X_OFFSET_TRENDLINE = -8;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export default function ChartStage({ bundle, axis }: ChartStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);

  const [paneSeries, setPaneSeries] = useState<Map<PaneId, ISeriesApi<any>>>(
    () => new Map(),
  );

  const registerPaneSeries = useCallback((paneId: PaneId, series: ISeriesApi<any>) => {
    setPaneSeries((prev) => {
      const next = new Map(prev);
      next.set(paneId, series);
      return next;
    });
  }, []);

  const unregisterPaneSeries = useCallback((paneId: PaneId) => {
    setPaneSeries((prev) => {
      if (!prev.has(paneId)) return prev;
      const next = new Map(prev);
      next.delete(paneId);
      return next;
    });
  }, []);

  const computeAnchor = useCallback((d: Drawing): { x: number; y: number } | null => {
    if (!chart || !axis || !paneSeries) return null;

    if (d.kind === 'hline') {
      const y = priceToCanvasY(chart, paneSeries, d.paneId, d.price);
      if (y == null) return null;
      // Return container-centre X. Panel applies translateX(-50%) for
      // hline kind so the visual centre lands here.
      const containerWidth = containerRef.current?.clientWidth ?? 0;
      return { x: containerWidth / 2, y: y + PANEL_Y_OFFSET };
    }

    if (d.kind === 'trendline') {
      const xa = realMsToCanvasX(chart, axis, d.a.realMs);
      const xb = realMsToCanvasX(chart, axis, d.b.realMs);
      const ya = priceToCanvasY(chart, paneSeries, d.paneId, d.a.price);
      const yb = priceToCanvasY(chart, paneSeries, d.paneId, d.b.price);
      if (xa == null || xb == null || ya == null || yb == null) return null;
      return {
        x: (xa + xb) / 2 + PANEL_X_OFFSET_TRENDLINE,
        y: (ya + yb) / 2 + PANEL_Y_OFFSET,
      };
    }

    // pencil
    let minX = Infinity, minY = Infinity;
    for (const p of d.points) {
      const x = realMsToCanvasX(chart, axis, p.realMs);
      const y = priceToCanvasY(chart, paneSeries, d.paneId, p.price);
      if (x != null && y != null) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
      }
    }
    if (!isFinite(minX) || !isFinite(minY)) return null;
    return { x: minX + PANEL_X_OFFSET_PENCIL, y: minY + PANEL_Y_OFFSET };
  }, [chart, axis, paneSeries]);

  // Per-pane prefs subscriptions live in each pane via useActivePrefs —
  // no ChartStage-level prefs subscription is needed. Each pane reads only
  // the slice it cares about, so flipping volumeProfileMode doesn't
  // re-render RatioPane and vice versa.
  // Keep the latest axis visible to the once-mounted subscribeVisibleTimeRange
  // handler. lightweight-charts emits times on our VIRTUAL axis (Task 6.1);
  // viewport consumers need REAL Unix-ms, so the handler reads this ref and
  // converts via axis.toReal.
  const axisRef: MutableRefObject<VirtualAxis> = useRef<VirtualAxis>(axis);
  useEffect(() => {
    axisRef.current = axis;
  }, [axis]);

  const activeCode = useTabsStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.selection?.code ?? null;
  });
  useEffect(() => {
    useDrawingsStore.getState().setActiveCode(activeCode);
  }, [activeCode]);

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
      // We own wheel interactions via a custom listener below. Disable the
      // library's built-in mouse-anchored zoom so the two paths can't fight
      // over the visible range. `pinch`, `axisPressedMouseMove`,
      // `axisDoubleClickReset` stay at defaults — only the wheel is reclaimed.
      handleScale: { mouseWheel: false },
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

    // Wire crosshair-move subscription. The sidebar's 10호가/거래원/체결
    // cards key off `tab.cursorMs`; users expect that cursor to follow
    // the MOUSE crosshair on the chart, not the viewport's right edge.
    // PriceStrip still writes the right edge as a fallback (initial
    // mount + pan/zoom with no concurrent hover), so the cards have a
    // sensible cursor before any hover happens. `param.time` is
    // undefined when the mouse leaves the chart or hovers an empty
    // area — in those cases we KEEP the last cursor (user preference,
    // 2026-05-23 grilling), so the cards don't blank out on mouseout.
    // rAF-coalesce crosshair events. lightweight-charts emits one per
    // browser mousemove (up to ~1 kHz on fast mice). Each emit caused
    // useTabsStore.setCursor → re-render of every sidebar card subscribed
    // via useCursor + a fresh per-cursor spot fetch. At most one cursor
    // write per frame is enough; nothing the sidebar shows updates faster
    // than the screen anyway.
    let crosshairRaf: number | null = null;
    let pendingRealMs: number | null = null;
    const crosshairHandler = (param: { time?: Time | undefined }) => {
      if (param.time === undefined) return;
      const a = axisRef.current;
      if (a.segments.length === 0) return;
      const virtualMs = (param.time as number) * 1000;
      pendingRealMs = a.toReal(virtualMs);
      if (crosshairRaf === null) {
        crosshairRaf = requestAnimationFrame(() => {
          crosshairRaf = null;
          if (pendingRealMs === null) return;
          const id = useTabsStore.getState().activeTabId;
          useTabsStore.getState().setCursor(id, pendingRealMs);
          pendingRealMs = null;
        });
      }
    };
    c.subscribeCrosshairMove(crosshairHandler);

    return () => {
      ts.unsubscribeVisibleTimeRangeChange(handler);
      c.unsubscribeCrosshairMove(crosshairHandler);
      if (crosshairRaf !== null) {
        cancelAnimationFrame(crosshairRaf);
        crosshairRaf = null;
      }
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

  // Initial fit-to-data + zoom-out floor. We use `timeScale.minBarSpacing`
  // (recomputed on resize) instead of a logical-range clamp because the
  // logical-range clamp made pan impossible when fully zoomed out: any
  // leftward drag pushed `range.from` negative, length grew past totalBars,
  // and the handler snapped the range back every frame. The barSpacing
  // approach lets pan past the data window remain free while still bounding
  // zoom-out to "all bars fit".
  useEffect(() => {
    if (!chart || !bundle) return;
    const ts = chart.timeScale();
    const container = containerRef.current;
    const totalBars = bundle.candles.length;

    const computeMinBarSpacing = (): number => {
      const width = container?.clientWidth ?? 0;
      if (width <= 0 || totalBars <= 0) return 0.5;
      return Math.max(0.5, width / totalBars);
    };

    ts.applyOptions({ minBarSpacing: computeMinBarSpacing() });
    ts.fitContent();

    // Keep the floor in sync with container width changes.
    const ro =
      container && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            ts.applyOptions({ minBarSpacing: computeMinBarSpacing() });
          })
        : null;
    if (ro && container) ro.observe(container);

    // Retain the existing zoom-in cap (barSpacing > 50): one bar/50px is
    // already absurdly zoomed-in; without it the user can vanish all but a
    // sliver of data on the right edge.
    const handler = (range: { from: number; to: number } | null) => {
      if (!range) return;
      const bs = ts.options().barSpacing;
      if (typeof bs === 'number' && bs > 50) {
        ts.applyOptions({ barSpacing: 50 });
      }
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(handler);
      ro?.disconnect();
    };
  }, [chart, bundle]);

  // Custom wheel handler — replaces the library's mouse-anchored default
  // with three modifier-aware behaviors:
  //   wheel              → zoom, right-edge anchored (latest visible candle)
  //   Shift + wheel      → pan time axis (no zoom)
  //   Ctrl/Cmd + wheel   → zoom, mouse-position anchored
  // The library's own wheel handler is disabled in createChart options.
  // Branch math lives in `util/wheelInteractions.ts` so it's testable
  // without a chart. Existing clamps (`barSpacing > 50` cap,
  // `minBarSpacing` floor) still apply because they run off the
  // `subscribeVisibleLogicalRangeChange` callback regardless of who
  // changed the range.
  useEffect(() => {
    const container = containerRef.current;
    if (!chart || !container) return;
    const ts = chart.timeScale();
    // `candles.length === 0` would yield maxTo=-1 and clamp every wheel
    // event to a degenerate range — guard against the brief empty-bundle
    // window before data loads.
    const maxTo =
      bundle && bundle.candles.length > 0
        ? bundle.candles.length - 1
        : Number.POSITIVE_INFINITY;

    const onWheel = (e: WheelEvent) => {
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const outcome = computeWheelOutcome({
        range,
        deltaY: e.deltaY,
        shiftKey: e.shiftKey,
        ctrlOrMetaKey: e.ctrlKey || e.metaKey,
        mouseX: e.clientX - rect.left,
        coordinateToLogical: (x) => ts.coordinateToLogical(x),
        maxTo,
      });
      if (outcome) ts.setVisibleLogicalRange(outcome);
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [chart, bundle]);

  return (
    <div className="relative h-full min-h-0 bg-bg-card overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />
      {chart && bundle && (
        <>
          {/*
            Series-only panes return null after registering their series on
            the chart. The wrapping `data-pane` divs are `hidden` so they
            don't occupy layout space but remain selectable by E2E specs
            asserting "pane was mounted".
          */}
          {/*
            Render order matches PANE_SPECS array index. The array's
            position carries the pane-index invariant: lightweight-charts
            v5 does not auto-create intermediate panes — a requested
            `paneIndex=N` while only K<N panes exist clamps to K. Mapping
            in order ensures every spec's paneIndex matches its array
            position so the clamp never fires.

            VolumeProfileOverlay below is still a canvas-overlay pane
            portaled into pane 0's DOM via `chart.panes()[0].getHTMLElement()`;
            the `data-pane` wrapper is kept for E2E selectors but no longer
            hosts the canvas itself.
          */}
          {PANE_SPECS.map((spec, paneIndex) => (
            <div key={spec.name} data-pane={spec.name} className="hidden">
              <RangeSeriesPane
                chart={chart}
                bundle={bundle}
                axis={axis}
                paneIndex={paneIndex}
                spec={spec}
                onPrimarySeriesReady={(s) => registerPaneSeries(spec.name, s)}
                onPrimarySeriesGone={() => unregisterPaneSeries(spec.name)}
              />
            </div>
          ))}
          <div data-pane="moving-average" className="hidden">
            <RangeSeriesPane
              chart={chart}
              bundle={bundle}
              axis={axis}
              paneIndex={0}
              spec={MOVING_AVERAGE_SPEC}
            />
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
          {/* Closing Auction Window shading (B1). Visible only when the
              auctionWindowMask toggle is on, giving analysts a cue that
              the RatioPane's zeroing during 15:20–15:30 KST is masking,
              not real "no pressure" data. */}
          <AuctionWindowOverlay chart={chart} axis={axis} />
          <DrawingOverlay chart={chart} axis={axis} paneSeries={paneSeries} />
          <DrawingPropertyPanel computeAnchor={computeAnchor} />
        </>
      )}
    </div>
  );
}
