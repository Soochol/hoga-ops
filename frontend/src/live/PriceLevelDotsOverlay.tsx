import { memo, useEffect, useReducer, useRef, type CSSProperties } from 'react';
import type { IChartApi, ITimeScaleApi, Time } from 'lightweight-charts';
import type { PriceLevelHit, RangeBundle } from '../api/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { useActivePrefs } from '../state/chartPrefs';
import { useLivePageStore } from '../state/livePage';

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
};

function readVisibleRange(ts: ITimeScaleApi<Time>): { from: number; to: number } | null {
  try {
    const r = ts.getVisibleRange();
    return r ? { from: Number(r.from), to: Number(r.to) } : null;
  } catch {
    return null;
  }
}

function lineStyle(x0: number, x1: number, y: number, color: string, lineWidth: number): CSSProperties {
  const left = Math.min(x0, x1);
  const width = Math.abs(x1 - x0);
  return {
    position: 'absolute',
    left,
    top: y - lineWidth / 2,
    width,
    height: lineWidth,
    borderRadius: Math.max(1, lineWidth / 2),
    backgroundColor: color,
    boxSizing: 'border-box',
    boxShadow: '0 0 0 1px rgba(2, 6, 23, 0.75)',
    opacity: 0.95,
  };
}

function formatTime(tMs: number): string {
  const d = new Date(tMs + 9 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function ariaLabel(hit: PriceLevelHit): string {
  const price = `${Math.round(hit.price).toLocaleString('ko-KR')}원`;
  if (hit.kind === 'limit') {
    return `${hit.direction === 'upper' ? '상한가' : '하한가'} ${price} ${formatTime(hit.t_ms)}`;
  }
  return `VI ${hit.direction === 'upper' ? '+' : '-'}${hit.pct}% ${price} ${formatTime(hit.t_ms)}`;
}

function PriceLevelDotsOverlay({ chart, bundle, axis, paneSeries }: Props) {
  const enabled = useActivePrefs((p) => p.viLimitPriceDotsEnabled);
  const color = useLivePageStore((s) => s.viLimitPriceLineColor);
  const lineWidth = useLivePageStore((s) => s.viLimitPriceLineWidth);
  const containerRef = useRef<HTMLDivElement>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!enabled) return;
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        tick();
      });
    };
    ts.subscribeVisibleLogicalRangeChange(schedule);
    const ro =
      containerRef.current && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      ro?.disconnect();
    };
  }, [chart, enabled]);

  if (!enabled) return null;

  const ts = chart.timeScale();
  const range = readVisibleRange(ts);
  const activeSeries = paneSeries.get('candle' as PaneId);
  const hits = activeSeries ? bundle.price_level_hits ?? [] : [];
  const segmentsByDate = new Map((bundle.segments ?? []).map((s) => [s.date, s]));
  const items = hits.map((hit) => {
    if (!activeSeries) return null;
    const segment = segmentsByDate.get(hit.date);
    if (!segment) return null;
    const startSec = axis.toVirtual(segment.session_open_ms) / 1000;
    const endSec = axis.toVirtual(segment.session_close_ms) / 1000;
    if (range && (endSec < range.from || startSec > range.to)) return null;
    let x0: ReturnType<typeof ts.timeToCoordinate>;
    let x1: ReturnType<typeof ts.timeToCoordinate>;
    let yc: ReturnType<typeof activeSeries.priceToCoordinate>;
    try {
      x0 = ts.timeToCoordinate(startSec as Time);
      x1 = ts.timeToCoordinate(endSec as Time);
      yc = activeSeries.priceToCoordinate(hit.price);
    } catch {
      return null;
    }
    if (x0 == null || x1 == null || yc == null) return null;
    return { hit, x0: Number(x0), x1: Number(x1), y: Number(yc) };
  });

  return (
    <div
      ref={containerRef}
      data-testid="price-level-lines-overlay"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 20 }}
    >
      {items.map(
        (it) =>
          it && (
            <span
              key={`${it.hit.date}-${it.hit.kind}-${it.hit.direction}-${it.hit.pct}-${it.hit.price}`}
              data-testid={`price-level-line-${it.hit.kind}-${it.hit.direction}-${it.hit.pct}`}
              aria-label={ariaLabel(it.hit)}
              role="img"
              style={lineStyle(it.x0, it.x1, it.y, color, lineWidth)}
            />
          ),
      )}
    </div>
  );
}

export default memo(PriceLevelDotsOverlay);
