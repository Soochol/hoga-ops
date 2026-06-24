import { memo, useEffect, useReducer, useRef, type CSSProperties } from 'react';
import type { IChartApi, ITimeScaleApi, Time } from 'lightweight-charts';
import type { PriceLevelHit, RangeBundle } from '../api/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { useActivePrefs } from '../state/chartPrefs';
import { resolveTokens } from '../util/tokens';

const TOKENS = resolveTokens({
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
  ring: ['--fg-dim', '#94A3B8'],
});

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

function dotStyle(hit: PriceLevelHit, x: number, y: number): CSSProperties {
  const color = hit.direction === 'upper' ? TOKENS.up : TOKENS.down;
  const isLimit = hit.kind === 'limit';
  return {
    position: 'absolute',
    left: x,
    top: y,
    width: isLimit ? 7 : 6,
    height: isLimit ? 7 : 6,
    borderRadius: '50%',
    background: color,
    border: isLimit ? `1px solid ${TOKENS.ring}` : 'none',
    transform: 'translate(-50%, -50%)',
    boxSizing: 'border-box',
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
  const items = hits.map((hit) => {
    if (!activeSeries) return null;
    const virtualMs = axis.toVirtual(hit.t_ms);
    const virtualSec = virtualMs / 1000;
    if (range && (virtualSec < range.from || virtualSec > range.to)) return null;
    let xc: ReturnType<typeof ts.timeToCoordinate>;
    let yc: ReturnType<typeof activeSeries.priceToCoordinate>;
    try {
      xc = ts.timeToCoordinate(virtualSec as Time);
      yc = activeSeries.priceToCoordinate(hit.price);
    } catch {
      return null;
    }
    if (xc == null || yc == null) return null;
    return { hit, x: Number(xc), y: Number(yc) };
  });

  return (
    <div
      ref={containerRef}
      data-testid="price-level-dots-overlay"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}
    >
      {items.map(
        (it) =>
          it && (
            <span
              key={`${it.hit.date}-${it.hit.kind}-${it.hit.direction}-${it.hit.pct}-${it.hit.price}`}
              data-testid={`price-level-dot-${it.hit.kind}-${it.hit.direction}-${it.hit.pct}`}
              aria-label={ariaLabel(it.hit)}
              role="img"
              style={dotStyle(it.hit, it.x, it.y)}
            />
          ),
      )}
    </div>
  );
}

export default memo(PriceLevelDotsOverlay);
