import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { WindowFrame, type WindowFrameProps } from './WindowFrame';
import { useMajorIndices } from './useMajorIndices';
import { indexPercentAt, type IndexPercentPoint } from './majorIndicesModel';
import { regularSessionOpenMs, regularSessionCloseMs } from '../liveDateTime';
import { unixMsToKSTHhmm } from '../../util/time';
import './MajorIndicesWindow.css';

type Overview = ReturnType<typeof useMajorIndices>;
const formatValue = (value: number | null) => value === null ? '—'
  : value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatPercent = (value: number | null) => value === null ? '—'
  : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
const timeLabel = (ms: number) => {
  const hhmm = unixMsToKSTHhmm(ms);
  return `${String(Math.floor(hhmm / 100)).padStart(2, '0')}:${String(hhmm % 100).padStart(2, '0')}`;
};

export function MajorIndicesWindow({ frameProps }: { frameProps: Omit<WindowFrameProps, 'children' | 'headerContent'> }) {
  const model = useMajorIndices();
  const description = `${model.date} · 전일 종가 대비 등락률 · ${model.label}`;
  return <WindowFrame {...frameProps} headerContent={
    <div className="major-indices-header" data-testid="major-indices-header">
      <span className="major-indices-title">주요 지수</span>
      <div className="major-indices-legend" aria-label="주요 지수 시세">
        {model.series.map(s => <span key={s.id} className="major-indices-quote">
          <span className="major-indices-name"><i aria-hidden style={{ background: s.color }} />{s.label}</span>
          <span className="major-indices-value">{formatValue(s.value)}</span>
          <span className="major-indices-percent">{formatPercent(s.percent)}</span>
        </span>)}
      </div>
      <span className="major-indices-status" role="status" aria-label={description}>{model.label}</span>
    </div>
  }><MajorIndicesChart model={model} /></WindowFrame>;
}

function linePath(points: readonly IndexPercentPoint[], x: (t: number) => number, y: (v: number) => number) {
  return points.map((point, i) => {
    const command = i === 0 || point.tMs - points[i - 1].tMs > 120_000 ? 'M' : 'L';
    return `${command}${x(point.tMs).toFixed(2)},${y(point.percent).toFixed(2)}`;
  }).join(' ');
}

function MajorIndicesChart({ model }: { model: Overview }) {
  const container = useRef<HTMLDivElement>(null);
  const axisLabels = useRef<SVGGElement>(null);
  const [axisWidth, setAxisWidth] = useState(52);
  const [size, setSize] = useState({ width: 600, height: 174 });
  // Fraction of the full regular session. Pointer movement only rerenders this
  // small SVG, not the query observers or the rest of the workspace.
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const clipId = useId().replaceAll(':', '');
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setSize(old => old.width === width && old.height === height ? old : { width, height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const { width, height } = size;
  const left = 5, right = Math.max(left + 10, width - axisWidth), top = 20, bottom = Math.max(top + 15, height - 21);
  const open = regularSessionOpenMs(model.date), close = regularSessionCloseMs(model.date);
  const values = model.series.flatMap(s => s.points.map(p => p.percent));
  const low = Math.min(0, ...values), high = Math.max(0, ...values);
  const step = Math.max(0.1, 10 ** Math.floor(Math.log10(Math.max(high - low, 0.2) / 4)));
  const tickStep = [1, 2, 5, 10].map(n => n * step).find(n => (high - low) / n <= 5) ?? step * 10;
  const min = Math.floor((low - tickStep * .15) / tickStep) * tickStep;
  const max = Math.ceil((high + tickStep * .15) / tickStep) * tickStep;
  const x = (t: number) => left + (t - open) / (close - open) * (right - left);
  const y = (v: number) => bottom - (v - min) / (max - min) * (bottom - top);
  const ticks: number[] = [];
  for (let value = min; value <= max + tickStep / 100; value += tickStep) ticks.push(Math.abs(value) < tickStep / 100 ? 0 : value);
  const decimals = tickStep >= 0.1 ? 1 : 2;
  useLayoutEffect(() => {
    const labels = Array.from(axisLabels.current?.querySelectorAll('text') ?? []);
    const measure = () => {
      const fontSize = (labels[0] && parseFloat(getComputedStyle(labels[0]).fontSize)) || 10.5;
      const next = Math.ceil(Math.max(52 * fontSize / 10.5, ...labels.map(label =>
        (typeof label.getComputedTextLength === 'function' ? label.getComputedTextLength() : label.getBoundingClientRect().width) + 14)));
      setAxisWidth(old => old === next ? old : next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    labels.forEach(label => observer.observe(label));
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [min, max, tickStep, decimals]);
  const cursorTime = hover === null ? null : open + hover * (close - open);
  const hovered = model.series.map(s => ({ ...s, at: cursorTime === null ? null : indexPercentAt(s.points, cursorTime) }));
  const hasData = values.length > 0;
  const move = (event: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(1, (event.clientX - bounds.left - left) / (right - left))));
  };
  const tooltipX = hover === null ? 0 : Math.max(2, Math.min(width - 132, x(open + hover * (close - open)) + (hover > .6 ? -132 : 10)));
  return <div ref={container} className="major-indices-chart" data-testid="major-indices-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${model.date} 코스피·코스닥·K200 당일 등락률 비교 · 오른쪽 Y축 등락률 %`}
      onPointerMove={event => { if (!pinned) move(event); }} onPointerLeave={() => { if (!pinned) setHover(null); }}
      onClick={event => { if (pinned) { setPinned(false); setHover(null); } else { move(event); setPinned(true); } }}>
      <defs><clipPath id={clipId}><rect x={left} y={top - 3} width={right - left + 3} height={bottom - top + 6} /></clipPath></defs>
      <text x={width - 5} y={12} textAnchor="end">등락률 %</text>
      <g ref={axisLabels} data-testid="major-indices-axis-labels">{ticks.map((value, i) => <g key={i}>
        <line x1={left} x2={right} y1={y(value)} y2={y(value)} className={value === 0 ? 'major-indices-zero' : 'major-indices-grid'} />
        <text x={right + 7} y={y(value) + 3.5}>{value > 0 ? '+' : ''}{value.toFixed(decimals)}%</text>
      </g>)}</g>
      <line x1={right} x2={right} y1={top} y2={bottom} className="major-indices-grid" />
      <text x={left} y={height - 5}>09:00</text>
      {width >= 300 && <text x={x(open + 3 * 3600_000)} y={height - 5} textAnchor="middle">12:00</text>}
      <text x={right} y={height - 5} textAnchor="end">15:30</text>
      <g clipPath={`url(#${clipId})`}>
        {model.series.map(s => <g key={s.id} data-index-series={s.id}>
          <path d={linePath(s.points, x, y)} fill="none" stroke={s.color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
          {s.points.length > 0 && <circle cx={x(s.points.at(-1)!.tMs)} cy={y(s.points.at(-1)!.percent)} r={2} fill={s.color} />}
        </g>)}
        {cursorTime !== null && hasData && <g>
          <line x1={x(cursorTime)} x2={x(cursorTime)} y1={top} y2={bottom} className="major-indices-cursor" />
          {hovered.map(s => s.at !== null && <circle key={s.id} cx={x(cursorTime)} cy={y(s.at)} r={3} fill={s.color} stroke="var(--bg-card)" />)}
        </g>}
      </g>
    </svg>
    {!hasData && <span className="major-indices-empty">{model.loading ? '지수 불러오는 중…' : '지수 데이터 없음'}</span>}
    {cursorTime !== null && hasData && <div className="major-indices-tooltip" role="tooltip" style={{ left: tooltipX }}>
      <span>{timeLabel(cursorTime)}</span>
      {hovered.map(s => <div key={s.id}><i aria-hidden style={{ background: s.color }} /><span>{s.label}</span><span>{formatPercent(s.at)}</span></div>)}
    </div>}
  </div>;
}
