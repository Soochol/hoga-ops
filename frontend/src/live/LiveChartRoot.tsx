import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  createChart,
  TickMarkType,
  type IChartApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { resolveTokens } from '../util/tokens';
import {
  CHART_CROSSHAIR_OPTIONS,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';
import { createVirtualAxis, type VirtualAxis } from '../util/virtualAxis';
import RangeSeriesPane from '../chart/RangeSeriesPane';
import { paneSpecsForTimeframe } from './paneSpecsForTimeframe';
import DayBoundaryOverlay from '../chart/DayBoundaryOverlay';
import {
  useLivePageStore,
  type LiveTimeframe,
  isMinuteTimeframe,
  isCalendarTimeframe,
} from '../state/livePage';
import type { RangeBundle } from '../api/types';
import {
  realMsToYyyymmdd,
  subtractDaysKst,
  prefetchChunkDaysFor,
} from './liveDateTime';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import MovingAverageOverlay from './indicators/MovingAverageOverlay';

const TOKEN_SPEC = {
  bgCard: ['--bg-card', '#13131C'],
  fg: ['--fg', '#E2E8F0'],
  grid: ['--grid', '#1A1A26'],
  border: ['--border', '#1F1F2A'],
} as const;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Empty axis used while the bundle is loading. timeFormatter / tickMarkFormatter
 * read through `axisRef.current` to convert virtual seconds back to real KST;
 * before the real axis arrives they need a working `.toReal()` to return
 * something that doesn't crash. Mirrors ChartStage's `axisRef` pattern. */
const EMPTY_AXIS: VirtualAxis = createVirtualAxis([]);

interface Props {
  code: string | null;
  timeframe: LiveTimeframe;
  bundle: RangeBundle | null;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
}

/** /live's single-chart root. Mounts the timeframe-appropriate pane set
 * (see `paneSpecsForTimeframe`) inside one createChart instance so
 * timeScale is shared across candle/volume/(hoga) panes. */
export function LiveChartRoot({ code, timeframe, bundle, clampEngaged, isPastCandlesLoading }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);
  // Eng review C1: memoise VirtualAxis on the segments array reference so
  // an SSE push that doesn't change segments doesn't churn the axis identity.
  const axis: VirtualAxis = useMemo(() => {
    if (!bundle || bundle.segments.length === 0) return EMPTY_AXIS;
    return createVirtualAxis(
      bundle.segments.map((s) => ({
        date: s.date,
        sessionOpenMs: s.session_open_ms,
        sessionCloseMs: s.session_close_ms,
      })),
    );
  }, [bundle?.segments]);

  // axisRef lets the once-mounted createChart formatters (timeFormatter +
  // tickMarkFormatter) read the latest axis without re-creating the chart.
  // Mirrors ChartStage's pattern — without this the formatters close over a
  // stale axis from first render and the x-axis renders virtual-seconds-as-
  // 1970-epoch ("02 1월 '70 ..."), which is exactly the bug we're fixing.
  const axisRef: MutableRefObject<VirtualAxis> = useRef<VirtualAxis>(axis);
  useEffect(() => {
    axisRef.current = axis;
  }, [axis]);

  // Publish axis to the shared store so LiveSidebar can read
  // axis.inClosingAuctionWindow(cursorMs) for TotalQtyBar mask.
  useEffect(() => {
    useLiveAxisStore.getState().setAxis(axis);
    return () => {
      useLiveAxisStore.getState().setAxis(null);
    };
  }, [axis]);

  // Viewport policy: trading-chart standard. Initial paint shows the
  // most recent INITIAL_VISIBLE_BARS candles (so today and recent past are
  // legible at native scale); series carries the full INITIAL_HISTORICAL_DAYS
  // window in memory. User drags left to reveal more past — and when they
  // drag past the leftmost loaded bar, the chunked-extension fetch fires
  // (see lazy-fetch trigger below).
  //
  // Without this, fitContent on a 20-day seed compresses today (≈30 1m
  // candles) into ~0.7% of the viewport — visually invisible. The whole
  // point of having today at all is to be the focus on first paint.
  //
  // Re-set the visible range only when (code, timeframe) changes — NOT on
  // every bundle update. SSE pushes inside today's segment must not snap
  // the user's scroll. The user-extended condition (historicalFromDate !=
  // null) also short-circuits — chunked extension lands silently.
  const didInitialViewRef = useRef(false);
  useEffect(() => {
    didInitialViewRef.current = false;
  }, [code, timeframe]);
  useEffect(() => {
    if (!chart || !bundle || bundle.candles.length === 0) return;
    if (didInitialViewRef.current) return;
    if (useLivePageStore.getState().historicalFromDate !== null) return;
    const ts = chart.timeScale();
    // Branch by timeframe, not bundle size. Minute timeframes carry ~5000
    // 1m bars and need the 300-bar windowing to stay legible; D/W/M carry
    // a few dozen bars at most and look right under fitContent now that
    // the hoga panes are gone (no vertical compression of candles). See
    // ADR-0041 + the 2026-05-28 spec.
    const target = 300;
    try {
      if (isMinuteTimeframe(timeframe)) {
        const totalBars = bundle.candles.length;
        const from = Math.max(0, totalBars - target);
        const to = totalBars + 5; // 5-bar right padding
        ts.setVisibleLogicalRange({ from, to });
      } else {
        ts.fitContent();
      }
      didInitialViewRef.current = true;
    } catch {
      // chart torn down between effect runs
    }
  }, [chart, bundle, timeframe]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const tokens = resolveTokens(TOKEN_SPEC);
    const c = createChart(el, {
      ...CHART_LAYOUT_OPTIONS,
      width: el.clientWidth,
      height: el.clientHeight,
      layout: { background: { color: tokens.bgCard }, textColor: tokens.fg },
      grid: { vertLines: { color: tokens.grid }, horzLines: { color: tokens.grid } },
      crosshair: CHART_CROSSHAIR_OPTIONS,
      // Virtual axis: lightweight-charts treats time values as Unix seconds,
      // but our values are virtual-ms offsets from segments[0].sessionOpenMs.
      // Both formatters convert virtual → real ms via axisRef.current.toReal,
      // then format in KST (UTC+9). Mirrors ChartStage's setup.
      localization: {
        timeFormatter: (time: Time): string => {
          const virtualMs = (time as number) * 1000;
          const a = axisRef.current;
          if (a.segments.length === 0) return '';
          const realMs = a.toReal(virtualMs);
          const d = new Date(realMs + 9 * 3600_000);
          return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        },
      },
      timeScale: {
        ...CHART_TIMESCALE_OPTIONS,
        timeVisible: true,
        secondsVisible: false,
        borderColor: tokens.border,
        tickMarkFormatter: (time: UTCTimestamp, tickType: TickMarkType): string => {
          const virtualMs = (time as number) * 1000;
          const a = axisRef.current;
          if (a.segments.length === 0) return '';
          const realMs = a.toReal(virtualMs);
          const d = new Date(realMs + 9 * 3600_000);
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

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) c.resize(w, h);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      c.remove();
      setChart(null);
    };
  }, []);

  // Lazy fetch trigger — extend historicalFromDate when user scrolls past
  // the leftmost loaded candle.
  //
  // Why logical range, not time range: subscribeVisibleTimeRangeChange clamps
  // r.from to the first candle's time (verified by wheel-pan test: from
  // decreases monotonically toward 0 and STOPS there — never negative). So
  // a time-API guard can never detect "user dragged past leftmost".
  // subscribeVisibleLogicalRangeChange emits FRACTIONAL bar indices that
  // freely go negative past the leftmost bar (-50.3 etc.), which is the
  // signal we actually need.
  //
  // Each trigger prepends one timeframe-sized chunk (see
  // prefetchChunkDaysFor — minute frames ≈ 1 trading day, daily ≈ 90
  // calendar days, W/M jump to the 250-day cap) from the current earliest
  // segment. The 150ms trailing debounce coalesces rapid wheel /
  // drag events into one fetch; the store's extendHistoricalRange is
  // monotonically decreasing, so repeated negative ranges in the same chunk
  // are no-ops. After the new chunk lands, axis.segments[0] becomes earlier,
  // so the next drag-past triggers another chunk relative to the new earliest.
  useEffect(() => {
    if (!chart) return;
    const ts = chart.timeScale();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const handler = (range: unknown) => {
      // Lazy-fetch runs for every LiveTimeframe, including D/W/M. The
      // candle backfill (/api/live/past-candles) is timeframe-independent
      // — useLiveBundle re-aggregates the same 1m bars into D/W/M on the
      // client. Without this, D/W/M users dragging past the leftmost bar
      // saw nothing happen.
      if (axis.segments.length === 0) return;
      const r = range as { from?: number | null; to?: number | null } | null;
      if (!r || r.from == null) return;
      // logical.from is a fractional bar index; negative = past the leftmost
      // loaded bar, which is exactly the lazy-fetch trigger condition.
      if (r.from >= 0) return;
      const currentEarliestDate = realMsToYyyymmdd(axis.segments[0].sessionOpenMs);
      const nextHistoricalFrom = subtractDaysKst(currentEarliestDate, prefetchChunkDaysFor(timeframe));
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        useLivePageStore.getState().extendHistoricalRange(nextHistoricalFrom);
      }, 150);
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      ts.unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [chart, axis, timeframe]);

  useEffect(() => {
    if (!chart || !bundle) return;
    const specs = paneSpecsForTimeframe(timeframe);
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      try {
        const panes = chart.panes();
        if (panes.length < specs.length) {
          requestAnimationFrame(apply);
          return;
        }
        panes.forEach((p, i) => {
          const f = specs[i]?.stretch;
          if (f !== undefined && typeof p.setStretchFactor === 'function') {
            p.setStretchFactor(f);
          }
        });
      } catch {
        // chart tearing down
      }
    };
    const raf = requestAnimationFrame(apply);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [chart, bundle, timeframe]);

  // ADR-0044: hover → cursor store. Only mount on minute timeframes —
  // calendar timeframes (D/W/M) don't have backing parquet on /live.
  // rAF-coalesce to one update per frame (matches ChartStage's pattern).
  useEffect(() => {
    if (!chart || !isMinuteTimeframe(timeframe)) {
      useLiveCursorStore.getState().clearCursor();
      return;
    }
    let pending: number | null = null;
    const handler = (param: { time?: unknown; point?: { x: number } | null }) => {
      if (param.point == null) {
        if (pending !== null) { cancelAnimationFrame(pending); pending = null; }
        useLiveCursorStore.getState().clearCursor();
        return;
      }
      if (pending !== null) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        pending = null;
        const t = param.time;
        if (typeof t !== 'number') return;
        // ChartStage.tsx:197 pattern — param.time is virtual-axis seconds.
        // Convert to virtual-ms, then real Unix-ms via axis.toReal().
        if (axis.segments.length === 0) return;
        const virtualMs = t * 1000;
        const realMs = axis.toReal(virtualMs);
        useLiveCursorStore.getState().setCursor(realMs);
      });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      if (pending !== null) cancelAnimationFrame(pending);
      useLiveCursorStore.getState().clearCursor();
    };
  }, [chart, axis, timeframe]);

  const dwDisabled = isCalendarTimeframe(timeframe);

  return (
    <div
      data-testid="live-chart-root"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', background: 'var(--bg-card)' }}
      />
      {chart && bundle && axis.segments.length > 0 && (
        <>
          {paneSpecsForTimeframe(timeframe).map((spec, i) => (
            <RangeSeriesPane
              key={spec.name}
              chart={chart}
              bundle={bundle}
              axis={axis}
              paneIndex={i}
              spec={spec}
            />
          ))}
          <MovingAverageOverlay chart={chart} bundle={bundle} axis={axis} />
          {/* Day boundary lines only make sense on intraday timeframes —
              D/W/M's candles are already day/week/month units, so a
              per-day vertical line collapses onto each candle. */}
          {isMinuteTimeframe(timeframe) && (
            <DayBoundaryOverlay chart={chart} axis={axis} />
          )}
        </>
      )}
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
      {isPastCandlesLoading && (!bundle || bundle.candles.length === 0) && (
        <div
          data-testid="past-candles-loading-note"
          style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', color: 'var(--fg-dimmer)',
            fontSize: 'var(--text-sm)',
          }}
        >
          분봉 불러오는 중…
        </div>
      )}
      {clampEngaged && (
        <div
          data-testid="clamp-engaged-chip"
          style={{
            position: 'absolute', bottom: 'var(--space-md)', left: 'var(--space-md)',
            padding: 'var(--space-xs) var(--space-md)',
            background: 'var(--bg-subtle)', color: 'var(--fg-dimmer)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-xs)',
            pointerEvents: 'none',
          }}
        >
          최대 60일까지 표시됩니다
        </div>
      )}
    </div>
  );
}

export default LiveChartRoot;
