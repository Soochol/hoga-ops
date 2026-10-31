import { useEffect, useMemo, useRef, useState } from 'react';
import { number, type Value } from './report';
import { chartPath } from './chartGeometry';

export type ChartLine = { id?: string; label: string; values: Value[]; color: string; dashed?: boolean; dash?: string };
const lineId = (line: ChartLine) => line.id ?? line.label;
const lineDash = (line: ChartLine) => line.dash ?? (line.dashed ? '5 4' : undefined);

export function BreadthChart({ dates, lines, label, height = 240, bounds = [0, 100],
  cursor, onCursor, unit = '점', compact = false, highlightedLine, onLineHover, onLineFocus,
}: {
  dates: string[]; lines: ChartLine[]; label: string; height?: number; bounds?: [number, number];
  cursor?: string; onCursor?: (date: string) => void; unit?: string; compact?: boolean;
  highlightedLine?: string | null; onLineHover?: (id: string | null) => void; onLineFocus?: (id: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(180, entry.contentRect.width)));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const left = 40, right = width - 12, bottom = height - 26, top = 12;
  const x = (i: number) => left + i * (right - left) / Math.max(1, dates.length - 1);
  const y = (v: number) => bottom - (v - bounds[0]) * (bottom - top) / (bounds[1] - bounds[0]);
  const selected = Math.max(0, dates.indexOf(cursor ?? dates.at(-1)!));
  const ticks = [bounds[0], (bounds[0] + bounds[1]) / 2, bounds[1]];
  // Cursor/hover updates only alter emphasis and labels, not thousands of path coordinates.
  const [min, max] = bounds;
  const paths = useMemo(() => lines.map(line => ({ line, path: chartPath(line.values,
    i => 40 + i * (width - 52) / Math.max(1, dates.length - 1),
    v => height - 26 - (v - min) * (height - 38) / (max - min)) })), [lines, dates.length, width, height, min, max]);
  const orderedPaths = highlightedLine ? [...paths.filter(p => lineId(p.line) !== highlightedLine), ...paths.filter(p => lineId(p.line) === highlightedLine)] : paths;
  return <div ref={host} className="breadth-chart">
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}
      onPointerMove={onCursor ? event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const i = Math.round(((event.clientX - rect.left) * width / rect.width - left) / (right - left) * (dates.length - 1));
        onCursor(dates[Math.max(0, Math.min(dates.length - 1, i))]);
      } : undefined}>
      <title>{label}</title>
      {ticks.map(v => <g key={v}>
        <line x1={left} x2={right} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
        <text x={left - 8} y={y(v) + 4} textAnchor="end">{number(v, 0)}</text>
      </g>)}
      {orderedPaths.map(({ line, path }) => <path key={lineId(line)} data-line-id={lineId(line)} d={path} fill="none" stroke={line.color}
        opacity={highlightedLine && lineId(line) !== highlightedLine ? 0.18 : 1}
        strokeWidth={lineId(line) === highlightedLine ? 3 : line.dashed ? 1.5 : 2} strokeDasharray={lineDash(line)} />)}
      {cursor && dates.includes(cursor) && <line x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} stroke="var(--fg-dim)" strokeDasharray="3 4" />}
      {dates.length > 0 && <>
        <text x={left} y={height - 5}>{dates[0].slice(5).replace('-', '.')}</text>
        <text x={right} y={height - 5} textAnchor="end">{dates.at(-1)!.slice(5).replace('-', '.')}</text>
      </>}
    </svg>
    {!compact && <div className="breadth-legend">
      <span>{dates[selected]} ·</span>
      <div className={`breadth-legend-values${onLineFocus ? ' breadth-legend-interactive' : ''}`}>
        {lines.map(line => {
          const content = <><svg className="breadth-line-swatch" width="24" height="12" viewBox="0 0 24 12" aria-hidden="true"><line x1="0" x2="24" y1="6" y2="6" stroke={line.color} strokeWidth="2" strokeDasharray={lineDash(line)} /></svg>{line.label} <b>{number(line.values[selected], unit === '점' || unit === '%' ? 2 : 0)}{unit}</b></>;
          return onLineFocus ? <button type="button" key={lineId(line)} className="breadth-legend-item"
            aria-label={`${line.label} 그래프 강조`} data-highlighted={highlightedLine === lineId(line)}
            onPointerEnter={() => onLineHover?.(lineId(line))} onPointerLeave={() => onLineHover?.(null)}
            onFocus={() => onLineFocus(lineId(line))} onBlur={() => onLineFocus(null)}>{content}</button>
            : <span key={lineId(line)}>{content}</span>;
        })}
      </div>
    </div>}
  </div>;
}
