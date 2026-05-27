import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, type IChartApi, type Time } from 'lightweight-charts';
import { resolveTokens } from '../util/tokens';
import {
  CHART_CROSSHAIR_OPTIONS,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';
import { createVirtualAxis, type VirtualAxis } from '../util/virtualAxis';
import RangeSeriesPane from '../chart/RangeSeriesPane';
import { PANE_SPECS, PANE_STRETCH } from '../chart/paneSpecs';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';
import { useLiveBundle } from './useLiveBundle';
import { todayKstYyyymmdd, realMsToYyyymmdd } from './liveDateTime';

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
  const axis: VirtualAxis | null = useMemo(() => {
    if (!bundle) return null;
    return createVirtualAxis(
      bundle.segments.map((s) => ({
        date: s.date,
        sessionOpenMs: s.session_open_ms,
        sessionCloseMs: s.session_close_ms,
      })),
    );
  }, [bundle?.segments]);

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
      timeScale: { ...CHART_TIMESCALE_OPTIONS, borderColor: tokens.border },
      crosshair: CHART_CROSSHAIR_OPTIONS,
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

  // Lazy fetch trigger — extend historicalFromDate when user scrolls left.
  // Eng review C2/C3: (a) require usable axis with >=1 segment; (b) 150ms
  // trailing debounce so a single pan gesture produces at most one extension call.
  useEffect(() => {
    if (!chart) return;
    const ts = chart.timeScale();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const handler = (range: unknown) => {
      if (!isMinuteTimeframe(timeframe)) return;
      if (!axis || axis.segments.length === 0) return;
      const r = range as { from?: Time | null } | null;
      if (!r || r.from == null) return;
      const sec = r.from as number;
      const realMs = axis.toReal(sec * 1000);
      const todayOpen = axis.segments[axis.segments.length - 1].sessionOpenMs;
      if (realMs >= todayOpen) return;
      const date = realMsToYyyymmdd(realMs);
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        useLivePageStore.getState().extendHistoricalRange(date);
      }, 150);
    };
    ts.subscribeVisibleTimeRangeChange(handler);
    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      ts.unsubscribeVisibleTimeRangeChange(handler);
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
      {chart && bundle && axis &&
        PANE_SPECS.map((spec, i) => (
          <RangeSeriesPane
            key={spec.name}
            chart={chart}
            bundle={bundle}
            axis={axis}
            paneIndex={i}
            spec={spec}
          />
        ))}
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
