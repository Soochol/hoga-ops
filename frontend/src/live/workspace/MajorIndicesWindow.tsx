import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { WindowFrame, type WindowFrameProps } from './WindowFrame';
import { useMajorIndices } from './useMajorIndices';
import { indexPercentAt, seriesValueAt } from './majorIndicesModel';
import { stockCloseRange } from './majorIndicesStockModel';
import { useMajorIndicesStock } from './useMajorIndicesStock';
import { majorIndicesTimeAxis } from './majorIndicesTimeAxis';
import { unixMsToKSTHhmm } from '../../util/time';
import { useWindowSettingsStore } from '../../state/windowSettings';
import { seedSettingsForWindow } from '../../state/windowSettingsLifecycle';
import { DEFAULT_MAJOR_INDICES_SETTINGS } from '../../state/majorIndicesSettings';
import { MajorIndicesSettings } from './MajorIndicesSettings';
import { WindowHeaderAction } from './WindowHeaderAction';
import { WindowSettingsPopover } from './WindowSettingsPopover';
import './MajorIndicesWindow.css';

type Overview = ReturnType<typeof useMajorIndices>;
const formatPercent = (value: number | null) => value === null ? '—'
  : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
const timeLabel = (ms: number) => {
  const hhmm = unixMsToKSTHhmm(ms);
  return `${String(Math.floor(hhmm / 100)).padStart(2, '0')}:${String(hhmm % 100).padStart(2, '0')}`;
};

export function MajorIndicesWindow({ frameProps }: { frameProps: Omit<WindowFrameProps, 'children' | 'headerContent'> }) {
  const windowId = frameProps.id;
  useLayoutEffect(() => seedSettingsForWindow({ id: windowId, kind: 'market-indices' }), [windowId]);
  const settings = useWindowSettingsStore(state => state.byWindow[windowId]?.majorIndices) ?? DEFAULT_MAJOR_INDICES_SETTINGS;
  const model = useMajorIndices(settings.indices);
  const code = !settings.showStock || frameProps.isIndex ? null : frameProps.symbolCode;
  const stock = useMajorIndicesStock(code, model.date);
  return <WindowFrame {...frameProps}>
    <WindowHeaderAction><WindowSettingsPopover title="주요 지수 설정" scope="이 창에 적용"
      render={() => <MajorIndicesSettings settings={settings}
        onChange={patch => useWindowSettingsStore.getState().patch(windowId, 'majorIndices', patch)} />} /></WindowHeaderAction>
    <MajorIndicesChart key={model.date} model={model} stock={stock} stockLabel={code ? frameProps.symbolLabel ?? code : null} />
  </WindowFrame>;
}

function linePath<T extends { tMs: number }>(points: readonly T[], x: (t: number) => number, y: (v: number) => number, value: (point: T) => number) {
  return points.map((point, i) => {
    const command = i === 0 || point.tMs - points[i - 1].tMs > 120_000 ? 'M' : 'L';
    return `${command}${x(point.tMs).toFixed(2)},${y(value(point)).toFixed(2)}`;
  }).join(' ');
}

function MajorIndicesChart({ model, stock, stockLabel }: {
  model: Overview; stock: ReturnType<typeof useMajorIndicesStock>; stockLabel: string | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const axisLabels = useRef<SVGGElement>(null);
  const [axisWidth, setAxisWidth] = useState(52);
  const [size, setSize] = useState({ width: 600, height: 174 });
  // Live hover follows the pointer's fraction; a pinned cursor keeps its actual
  // timestamp when the time axis grows. The date key resets both on a new day.
  const [hover, setHover] = useState<number | null>(null);
  const [pinnedTime, setPinnedTime] = useState<number | null>(null);
  const pinned = pinnedTime !== null;
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
  const { start: open, end, ticks: timeTicks } = majorIndicesTimeAxis(model.date, model.now, right - left, Math.max(64, axisWidth));
  const timeSpan = end - open;
  const values = model.series.flatMap(s => s.points.map(p => p.percent));
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 0;
  const step = Math.max(0.1, 10 ** Math.floor(Math.log10(Math.max(high - low, 0.2) / 4)));
  const tickStep = [1, 2, 5, 10].map(n => n * step).find(n => (high - low) / n <= 5) ?? step * 10;
  const min = Math.floor((low - tickStep * .15) / tickStep) * tickStep;
  const max = Math.ceil((high + tickStep * .15) / tickStep) * tickStep;
  const x = (t: number) => left + (t - open) / Math.max(1, timeSpan) * (right - left);
  const y = (v: number) => bottom - (v - min) / (max - min) * (bottom - top);
  const stockRange = stockCloseRange(stock.points);
  const stockY = (price: number) => stockRange
    ? bottom - (price - stockRange.min) / (stockRange.max - stockRange.min) * (bottom - top) : top;
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
  const cursorTimeRaw = pinnedTime ?? (hover === null ? null : open + hover * timeSpan);
  const cursorTime = cursorTimeRaw === null ? null : Math.floor(cursorTimeRaw / 60_000) * 60_000;
  const hovered = model.series.map(s => ({ ...s, at: cursorTime === null ? null : indexPercentAt(s.points, cursorTime) }));
  const stockAt = cursorTime === null ? null : seriesValueAt(stock.points, cursorTime, point => point.close, 0);
  const hasData = values.length > 0 || stock.points.length > 0;
  const pointerFraction = (event: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - bounds.left - left) / (right - left)));
  };
  const cursorX = cursorTime === null ? left : x(cursorTime);
  const tooltipX = Math.max(2, Math.min(width - 132, cursorX + (cursorX > left + (right - left) * .6 ? -132 : 10)));
  return <div className="major-indices-view">
    <div className="major-indices-legend text-xs text-fg-dim" role="list" aria-label="표시 항목">
      {model.series.map(series => <span key={series.id} role="listitem">
        <i aria-hidden style={{ background: series.color }} />{series.label}
      </span>)}
      {stockLabel && <span role="listitem"><i aria-hidden style={{ background: 'var(--accent)' }} />{stockLabel}</span>}
    </div>
    <div ref={container} className="major-indices-chart" data-testid="major-indices-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${model.date} ${model.series.map(series => series.label).join('·')} 당일 등락률 비교 · 오른쪽 Y축 등락률 %${stockLabel ? ` · ${stockLabel} 종가` : ''}`}
      onPointerMove={event => { if (!pinned) setHover(pointerFraction(event)); }}
      onPointerLeave={() => { if (!pinned) setHover(null); }}
      onClick={event => {
        if (pinned) { setPinnedTime(null); setHover(null); }
        else setPinnedTime(open + pointerFraction(event) * timeSpan);
      }}>
      <defs><clipPath id={clipId}><rect x={left} y={top - 3} width={right - left + 3} height={bottom - top + 6} /></clipPath></defs>
      <text x={width - 5} y={12} textAnchor="end">등락률 %</text>
      <g ref={axisLabels} data-testid="major-indices-axis-labels">{ticks.map((value, i) => <g key={i}>
        <line x1={left} x2={right} y1={y(value)} y2={y(value)} className={value === 0 ? 'major-indices-zero' : 'major-indices-grid'} />
        <text x={right + 7} y={y(value) + 3.5}>{value > 0 ? '+' : ''}{value.toFixed(decimals)}%</text>
      </g>)}</g>
      <line x1={right} x2={right} y1={top} y2={bottom} className="major-indices-grid" />
      <g data-testid="major-indices-time-axis">{timeTicks.map(time =>
        <text key={time} x={time === end && time !== open ? right : x(time)} y={height - 5}
          textAnchor={time === open ? 'start' : time === end ? 'end' : 'middle'}>{timeLabel(time)}</text>
      )}</g>
      <g clipPath={`url(#${clipId})`}>
        {model.series.map(s => <g key={s.id} data-index-series={s.id}>
          <path d={linePath(s.points, x, y, point => point.percent)} fill="none" stroke={s.color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
          {s.points.length > 0 && <circle cx={x(s.points.at(-1)!.tMs)} cy={y(s.points.at(-1)!.percent)} r={2} fill={s.color} />}
        </g>)}
        {stockLabel && stock.points.length > 0 && <g data-stock-series="" aria-label={`${stockLabel} 종가`}>
          <path d={linePath(stock.points, x, stockY, point => point.close)} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(stock.points.at(-1)!.tMs)} cy={stockY(stock.points.at(-1)!.close)} r={2} fill="var(--accent)" />
        </g>}
        {cursorTime !== null && hasData && <g>
          <line x1={x(cursorTime)} x2={x(cursorTime)} y1={top} y2={bottom} className="major-indices-cursor" />
          {hovered.map(s => s.at !== null && <circle key={s.id} cx={x(cursorTime)} cy={y(s.at)} r={3} fill={s.color} stroke="var(--bg-card)" />)}
          {stockAt !== null && <circle cx={x(cursorTime)} cy={stockY(stockAt)} r={3} fill="var(--accent)" stroke="var(--bg-card)" />}
        </g>}
      </g>
    </svg>
    {values.length === 0 && <span className="major-indices-empty">{model.loading ? '지수 불러오는 중…' : '지수 데이터 없음'}</span>}
    {stockLabel && (stock.failed || !stock.points.length) && <span className="major-indices-stock-notice text-xs text-fg-dim" role="status">
      {stock.failed ? `${stockLabel} 종가 조회 실패` : stock.loading ? `${stockLabel} 불러오는 중…` : `${stockLabel} 종가 데이터 없음`}
    </span>}
    {cursorTime !== null && hasData && <div className="tooltip-surface major-indices-tooltip" role="tooltip" style={{ left: tooltipX }}>
      <span>{timeLabel(cursorTime)}</span>
      {hovered.map(s => <div key={s.id}><i aria-hidden style={{ background: s.color }} /><span>{s.label}</span><span>{formatPercent(s.at)}</span></div>)}
      {stockLabel && <div><i aria-hidden style={{ background: 'var(--accent)' }} /><span>{stockLabel}</span><span>{stockAt === null ? '—' : `${stockAt.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`}</span></div>}
    </div>}
  </div></div>;
}
