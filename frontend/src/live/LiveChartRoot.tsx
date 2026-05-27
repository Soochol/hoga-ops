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
import { PANE_SPECS, PANE_STRETCH } from '../chart/paneSpecs';
import DayBoundaryOverlay from '../chart/DayBoundaryOverlay';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';
import { useLiveBundle } from './useLiveBundle';
import {
  todayKstYyyymmdd,
  realMsToYyyymmdd,
  subtractDaysKst,
  PREFETCH_CHUNK_DAYS,
} from './liveDateTime';

const TOKEN_SPEC = {
  bgCard: ['--bg-card', '#13131C'],
  fg: ['--fg', '#E2E8F0'],
  grid: ['--grid', '#1A1A26'],
  border: ['--border', '#1F1F2A'],
} as const;

const MINUTE_TIMEFRAMES: ReadonlyArray<LiveTimeframe> = ['1m', '3m', '5m', '10m', '15m', '30m'];
function isMinuteTimeframe(tf: LiveTimeframe): boolean {
  return MINUTE_TIMEFRAMES.includes(tf);
}

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
}

/** /live's single-chart root. Mounts PANE_SPECS 0-4 inside one createChart
 * instance so timeScale is shared across candle/volume/3-hoga panes. */
export function LiveChartRoot({ code, timeframe }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);
  const today = todayKstYyyymmdd();

  const { bundle } = useLiveBundle(code, timeframe, today);
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

  // Auto-fitContent on segment-count growth.
  //
  // The mount sequence delivers data in stages: useLiveCandles resolves first
  // (today only → segments=1), then /api/range arrives (past + today → segments=21).
  // A single first-arrival fit ref would lock the viewport to "today only"
  // because the fit fired before past.data landed. Instead, refit every time
  // segments.length INCREASES — SSE updates that only mutate candles inside
  // existing segments don't grow the count, so they don't snap the viewport.
  //
  // Once the user explicitly scrolls past the leftmost candle (which sets
  // historicalFromDate via extendHistoricalRange), stop auto-fitting so
  // chunked extensions land without resetting the user's scroll position.
  //
  // Switching code or timeframe resets historicalFromDate to null (livePage
  // store action) AND resets the segment-count ref so the next bundle's
  // first-stable state re-fits.
  const prevSegmentCountRef = useRef(0);
  useEffect(() => {
    prevSegmentCountRef.current = 0;
  }, [code, timeframe]);
  useEffect(() => {
    if (!chart || !bundle) return;
    const prev = prevSegmentCountRef.current;
    const next = bundle.segments.length;
    prevSegmentCountRef.current = next;
    if (next <= prev) return;
    if (next === 0) return;
    if (useLivePageStore.getState().historicalFromDate !== null) return;
    chart.timeScale().fitContent();
  }, [chart, bundle]);

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
  // Each trigger prepends one PREFETCH_CHUNK_DAYS chunk from the current
  // earliest segment. The 150ms trailing debounce coalesces rapid wheel /
  // drag events into one fetch; the store's extendHistoricalRange is
  // monotonically decreasing, so repeated negative ranges in the same chunk
  // are no-ops. After the new chunk lands, axis.segments[0] becomes earlier,
  // so the next drag-past triggers another chunk relative to the new earliest.
  useEffect(() => {
    if (!chart) return;
    const ts = chart.timeScale();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const handler = (range: unknown) => {
      if (!isMinuteTimeframe(timeframe)) return;
      if (axis.segments.length === 0) return;
      const r = range as { from?: number | null; to?: number | null } | null;
      if (!r || r.from == null) return;
      // logical.from is a fractional bar index; negative = past the leftmost
      // loaded bar, which is exactly the lazy-fetch trigger condition.
      if (r.from >= 0) return;
      const currentEarliestDate = realMsToYyyymmdd(axis.segments[0].sessionOpenMs);
      const nextHistoricalFrom = subtractDaysKst(currentEarliestDate, PREFETCH_CHUNK_DAYS);
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
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      try {
        const panes = chart.panes();
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
        // chart tearing down
      }
    };
    const raf = requestAnimationFrame(apply);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [chart, bundle]);

  const dwDisabled = !isMinuteTimeframe(timeframe);

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
          {PANE_SPECS.map((spec, i) => (
            <RangeSeriesPane
              key={spec.name}
              chart={chart}
              bundle={bundle}
              axis={axis}
              paneIndex={i}
              spec={spec}
            />
          ))}
          {/* Day boundary lines on multi-day axes — same component /replay uses. */}
          <DayBoundaryOverlay chart={chart} axis={axis} />
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
    </div>
  );
}

export default LiveChartRoot;
