import { memo, useMemo } from 'react';
import type { PanelGroupFlow, PanelStockFlow } from '../api/panelFlow';
import { priceDirClass } from '../ui/priceDir';

const W = 64, H = 16;
const EMPTY: (number | null)[] = [];
const observedTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export function latestFlowValue(series: readonly (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] != null && Number.isFinite(series[i])) return series[i];
  return null;
}

/** Geometry is memoized independently of live prices/selection/drag updates.
 * Full-day indices are preserved: gaps break paths and future time stays blank. */
const Sparkline = memo(function Sparkline({ series, label }: { series: (number | null)[]; label: string }) {
  const geometry = useMemo(() => {
    const valid = series.filter((value): value is number => value != null && Number.isFinite(value));
    if (!valid.length) return null;
    const lo = Math.min(0, ...valid), hi = Math.max(0, ...valid);
    const y = (value: number) => 14 - (value - lo) / (hi - lo || 1) * 12;
    const x = (index: number) => 1 + index / Math.max(1, series.length - 1) * 62;
    let line = '', area = '', segment: string[] = [];
    const isolated: { x: number; y: number }[] = [];
    const flush = () => {
      if (segment.length === 1) {
        const [px, py] = segment[0].split(',').map(Number);
        isolated.push({ x: px, y: py });
      }
      if (segment.length) area += `M${segment[0].split(',')[0]},${y(0).toFixed(2)} L${segment.join(' L')} L${segment.at(-1)!.split(',')[0]},${y(0).toFixed(2)} Z `;
      segment = [];
    };
    series.forEach((value, index) => {
      if (value == null || !Number.isFinite(value)) { flush(); return; }
      const point = { x: x(index), y: y(value) };
      line += `${segment.length ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)} `;
      segment.push(`${point.x.toFixed(2)},${point.y.toFixed(2)}`);
    });
    flush();
    return { line, area, zero: y(0), isolated, last: valid.at(-1)! };
  }, [series]);
  return <span className="quote-row-flow flex-none" role="img" aria-label={label}>
    {geometry ? <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className={priceDirClass(geometry.last)} aria-hidden>
      <path d={geometry.area} fill="currentColor" opacity={0.1} />
      <line x1={0} y1={geometry.zero} x2={W} y2={geometry.zero} stroke="var(--grid)" strokeWidth={1} />
      <path d={geometry.line} fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" />
      {geometry.isolated.map(point => <circle key={point.x} cx={point.x} cy={point.y} r={1.3} fill="currentColor" />)}
    </svg> : <span className="text-2xs text-fg-dim whitespace-nowrap">흐름 없음</span>}
  </span>;
});

export const PanelStockSparkline = memo(function PanelStockSparkline({ flow, name }: { flow: PanelStockFlow | null; name: string }) {
  const reason = flow?.missing_reason === 'unsupported_market' ? '미국 종목 당일 흐름 미지원'
    : flow?.missing_reason === 'no_baseline' ? '전일 기준가 없음' : '수집된 당일 분봉 없음';
  const detail = flow?.last_observed_ms != null ? `${flow.venue} · 마지막 관측 ${observedTime.format(flow.last_observed_ms)}` : reason;
  return <Sparkline series={flow?.pct ?? EMPTY} label={`${name} 당일 흐름 · ${detail}`} />;
});

export const PanelGroupSparkline = memo(function PanelGroupSparkline({ flow, name }: { flow: PanelGroupFlow | null; name: string }) {
  const series = flow?.pct ?? EMPTY;
  let last = series.length - 1;
  while (last >= 0 && series[last] == null) last--;
  return <Sparkline series={series} label={`${name} 그룹 당일 흐름 · 평균 반영 ${flow?.counts[last] ?? 0}/${flow?.total ?? 0}종목`} />;
});

export function PanelFlowNotice({ failed, refreshing, retry }: { failed: boolean; refreshing: boolean; retry: () => void }) {
  if (!failed) return null;
  return <div role="status" className="px-3 py-1 text-xs text-fg-dim">흐름을 갱신하지 못했습니다. <button type="button" className="text-accent" disabled={refreshing} onClick={retry}>다시 시도</button></div>;
}
