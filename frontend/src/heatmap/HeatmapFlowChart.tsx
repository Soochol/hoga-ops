import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { flowLinePath, flowTimeLabel, flowValueAt, type FlowPoint } from './flowComparison';

export interface FlowChartSeries { id: string; name: string; color: string; points: FlowPoint[] }
interface Props {
  series: FlowChartSeries[];
  start: number;
  end: number;
  latest: number | null;
  cursor: number;
  unit: string;
  highlighted: string | null;
  onHover: (time: number) => void;
  onPin: (time: number) => void;
}

export function HeatmapFlowChart({ series, start, end, latest, cursor, unit, highlighted, onHover, onPin }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 440 });
  const clipId = useId();
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width > 0 && height > 0) setSize({ width, height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    let lo = 0, hi = 0;
    for (const s of series) for (const p of s.points) {
      if (p.value !== null) { lo = Math.min(lo, p.value); hi = Math.max(hi, p.value); }
    }
    const span = hi - lo || 2;
    const rawStep = span / 5;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const step = ([1, 2, 5, 10].find((v) => v * magnitude >= rawStep) ?? 10) * magnitude;
    const low = Math.floor((lo - span * .08) / step) * step;
    const high = Math.ceil((hi + span * .08) / step) * step;
    const ticks = Array.from({ length: Math.round((high - low) / step) + 1 }, (_, i) => low + i * step);
    const left = 58, right = Math.max(left + 1, size.width - 18), top = 25, bottom = size.height - 46;
    const x = (time: number) => left + (time - start) / Math.max(1, end - start) * (right - left);
    const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
    const timeTicks = size.width < 420 ? [start, start + (end - start) / 2, end]
      : Array.from({ length: Math.ceil((end - start) / 3_600_000) }, (_, i) => start + i * 3_600_000).concat(end);
    const precision = Math.max(1, -Math.floor(Math.log10(step)));
    return { ticks, timeTicks, precision, left, right, top, bottom, x, y };
  }, [series, size, start, end]);
  const { ticks, timeTicks, precision, left, right, top, bottom, x, y } = geometry;
  const labelX = Math.max(left + 25, Math.min(right - 25, x(cursor)));
  const timeFromPointer = (event: PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    return Math.min(latest ?? end, start + fraction * (end - start));
  };

  return (
    <div ref={container} className="heatmap-flow-chart">
      <svg viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label="그룹별 장중 흐름 비교 차트">
        <title>같은 시간축과 공통 Y축에서 비교한 그룹별 흐름</title>
        <desc>마우스를 움직이면 같은 시각의 그룹별 수치를 표시합니다. 클릭하면 시각을 고정합니다. 아래 시각 선택 막대는 키보드로 조절할 수 있습니다.</desc>
        <defs><clipPath id={clipId}><rect x={left} y={top} width={right - left} height={bottom - top} /></clipPath></defs>
        {ticks.map((tick) => <g key={tick}>
          <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} className={Math.abs(tick) < 1e-8 ? 'flow-zero' : 'flow-grid'} />
          <text x={left - 9} y={y(tick)} dominantBaseline="middle" textAnchor="end">{Math.abs(tick) < 1e-8 ? '0.0' : `${tick > 0 ? '+' : ''}${tick.toFixed(precision)}`}</text>
        </g>)}
        <text x={left} y={14}>{unit}</text>
        {timeTicks.filter((time) => Math.abs(x(time) - labelX) > 43).map((time, index, array) =>
          <text key={time} x={x(time)} y={bottom + 20} textAnchor={index === 0 && time === start ? 'start' : index === array.length - 1 && time === end ? 'end' : 'middle'}>{flowTimeLabel(time)}</text>)}
        <text x={right} y={size.height - 3} textAnchor="end">시각 · KST</text>
        {latest !== null && latest < end && <>
          <line x1={x(latest)} x2={x(latest)} y1={top} y2={bottom} className="flow-grid" />
          {right - x(latest) > 85 && <text x={(right + x(latest)) / 2} y={top + 15} textAnchor="middle">데이터 미수신</text>}
        </>}
        <g clipPath={`url(#${clipId})`}>
          {series.map((s) => <g key={s.id} opacity={highlighted && highlighted !== s.id ? .18 : 1}>
            <path data-testid={`flow-line-${s.id}`} d={flowLinePath(s.points, x, y)} fill="none" stroke={s.color} strokeWidth={highlighted === s.id ? 2.5 : 1.5} strokeLinejoin="round" strokeLinecap="round" />
            {s.points.filter((p, i, points) => p.value !== null && points[i - 1]?.value == null && points[i + 1]?.value == null).map((p) =>
              <circle key={p.time} cx={x(p.time)} cy={y(p.value!)} r={2.5} fill={s.color} />)}
          </g>)}
        </g>
        {latest !== null && <g>
          <line x1={x(cursor)} x2={x(cursor)} y1={top} y2={bottom} className="flow-cursor" />
          {series.map((s) => {
            const value = flowValueAt(s.points, cursor);
            return value === null ? null : <circle key={s.id} cx={x(cursor)} cy={y(value)} r={3.5} fill={s.color} stroke="var(--bg)" strokeWidth={1.5} />;
          })}
          <rect x={labelX - 25} y={bottom + 4} width={50} height={22} rx={3} fill="var(--bg-input-hover)" />
          <text className="flow-cursor-label" x={labelX} y={bottom + 19} textAnchor="middle">{flowTimeLabel(cursor)}</text>
        </g>}
        <rect data-testid="flow-chart-hit" x={left} y={top} width={right - left} height={bottom - top} fill="transparent"
          onPointerMove={(event) => { if (event.pointerType !== 'touch') onHover(timeFromPointer(event)); }}
          onPointerDown={(event) => { if (latest !== null) onPin(timeFromPointer(event)); }} />
      </svg>
    </div>
  );
}
