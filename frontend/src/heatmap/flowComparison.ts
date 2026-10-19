import type { HeatmapGroupFlowResponse } from '../api/heatmapGroupFlow';
import type { FlowComparisonMode } from '../state/heatmapFlowPrefs';

export const FLOW_MODE_LABELS: Record<FlowComparisonMode, string> = {
  absolute: '전일 종가 대비', relative: '첫 구간 대비', momentum: '최근 30분 변화',
};

export interface FlowPoint { time: number; value: number | null }

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 버킷 인덱스를 보존한다. 결측을 제거하면 그룹 사이의 비교 시각이 달라진다. */
export function flowPoints(
  pct: (number | null)[], baseMs: number, bucketMs: number, mode: FlowComparisonMode,
): FlowPoint[] {
  const first = finite(pct[0]);
  const lag = 30 * 60_000 / bucketMs;
  return pct.map((raw, i) => {
    const current = finite(raw);
    const reference = mode === 'relative' ? first
      : mode === 'momentum' ? (Number.isInteger(lag) ? finite(pct[i - lag]) : null) : 0;
    return { time: baseMs + i * bucketMs, value: current === null || reference === null ? null : current - reference };
  });
}

/** 같은 시각을 보간하되 null·배열 밖을 가로질러 값을 만들어내지 않는다. */
export function flowValueAt(points: FlowPoint[], time: number): number | null {
  if (!points.length || time < points[0].time || time > points[points.length - 1].time) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid].time <= time) lo = mid; else hi = mid - 1;
  }
  const a = points[lo];
  if (a.time === time) return a.value;
  const b = points[lo + 1];
  if (a.value === null || !b || b.value === null) return null;
  return a.value + (b.value - a.value) * (time - a.time) / (b.time - a.time);
}

/** null에서 경로를 끊는다. 관측 한 점도 별도 원으로 표시한다. */
export function flowLinePath(points: FlowPoint[], x: (time: number) => number, y: (value: number) => number): string {
  let connected = false;
  return points.map((p) => {
    if (p.value === null) { connected = false; return ''; }
    const command = connected ? 'L' : 'M';
    connected = true;
    return `${command}${x(p.time).toFixed(2)},${y(p.value).toFixed(2)}`;
  }).join(' ');
}

export function latestFlowTime(data: HeatmapGroupFlowResponse, ids: string[]): number | null {
  let index = -1;
  const selected = new Set(ids);
  for (const group of data.groups) {
    if (!selected.has(group.folder_id)) continue;
    for (let i = group.pct.length - 1; i > index; i--) {
      if (finite(group.pct[i]) !== null) { index = i; break; }
    }
  }
  return index < 0 ? null : data.t_base_ms + index * data.bucket_ms;
}

const kstTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function flowTimeLabel(time: number): string { return kstTime.format(time); }
export function flowValueLabel(value: number | null, unit: string): string {
  if (value === null) return '—';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(2)}${unit}`;
}
