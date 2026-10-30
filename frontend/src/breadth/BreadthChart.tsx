import { useEffect, useRef, useState } from 'react';
import { number, type Value } from './report';

export type ChartLine = { label: string; values: Value[]; color: string; dashed?: boolean };
export const CHART_COLORS = ['var(--ma-1)', 'var(--ma-2)', 'var(--ma-6)'];

/** Nulls break paths. Every x position is an actual trading session. */
export function chartPath(values: Value[], x: (i: number) => number, y: (v: number) => number): string {
  let path = '', pen = false;
  values.forEach((v, i) => {
    if (v === null) { pen = false; return; }
    path += `${pen ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)} `;
    pen = true;
  });
  return path.trim();
}

export function BreadthChart({ dates, lines, label, height = 240, bounds = [0, 100],
  cursor, onCursor, unit = '점', compact = false,
}: {
  dates: string[]; lines: ChartLine[]; label: string; height?: number; bounds?: [number, number];
  cursor?: string; onCursor?: (date: string) => void; unit?: string; compact?: boolean;
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
      {lines.map(line => <path key={line.label} d={chartPath(line.values, x, y)} fill="none" stroke={line.color}
        strokeWidth={line.dashed ? 1.5 : 2} strokeDasharray={line.dashed ? '5 4' : undefined} />)}
      {cursor && dates.includes(cursor) && <line x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} stroke="var(--fg-dim)" strokeDasharray="3 4" />}
      {dates.length > 0 && <>
        <text x={left} y={height - 5}>{dates[0].slice(5).replace('-', '.')}</text>
        <text x={right} y={height - 5} textAnchor="end">{dates.at(-1)!.slice(5).replace('-', '.')}</text>
      </>}
    </svg>
    {!compact && <div className="breadth-legend" aria-live="polite">
      <span>{dates[selected]} ·</span>
      {lines.map(line => <span key={line.label}><i style={{ background: line.color }} />{line.label} <b>{number(line.values[selected], unit === '점' || unit === '%' ? 2 : 0)}{unit}</b></span>)}
    </div>}
  </div>;
}
