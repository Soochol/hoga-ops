import { useEffect, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { resolveTokens } from '../util/tokens';

const TOKEN_SPEC = { borderStrong: ['--border-strong', '#2A2A38'] } as const;

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
};

function fmtMD(yyyymmdd: string): string {
  return `${Number(yyyymmdd.slice(4, 6))}/${Number(yyyymmdd.slice(6, 8))}`;
}

/**
 * Vertical line + MM/DD chip per Day Boundary (CONTEXT.md). The reposition
 * handler coalesces subscribeVisibleLogicalRangeChange + ResizeObserver
 * events through requestAnimationFrame and mutates only transform:translateX
 * (GPU compositor path, no layout thrash). plan-eng-review Perf #1.
 *
 * N segments → N-1 boundaries (no boundary at the start of segment[0]).
 */
export default function DayBoundaryOverlay({ chart, axis }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => force((n) => n + 1));
    };
    ts.subscribeVisibleLogicalRangeChange(schedule);
    const parent = containerRef.current?.parentElement;
    const ro =
      parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro && parent) ro.observe(parent);
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      ro?.disconnect();
    };
  }, [chart]);

  if (axis.segments.length < 2) return null;

  const { borderStrong } = resolveTokens(TOKEN_SPEC);

  const ts = chart.timeScale();
  const boundaries = axis.dayBoundaries.map((b) => {
    const x = ts.timeToCoordinate((b.virtualStart / 1000) as UTCTimestamp);
    return { date: b.date, x };
  });

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none z-10">
      {boundaries.map((b) =>
        b.x == null ? null : (
          <div
            key={b.date}
            data-day-boundary={b.date}
            className="absolute top-0 bottom-0 w-px"
            style={{
              transform: `translateX(${b.x as number}px)`,
              backgroundImage: `repeating-linear-gradient(to bottom, ${borderStrong} 0 3px, transparent 3px 6px)`,
            }}
          >
            <span className="absolute top-1 left-1 bg-bg-card text-fg-dim text-xs px-1.5 py-0.5 rounded">
              {fmtMD(b.date)}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
