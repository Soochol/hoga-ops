import type { LiveTimeframe } from '../state/livePage';

export type LiveTabMetrics = {
  changePct?: number | null;
};

export type LiveViewLabelParts = {
  primary: string;
  detail?: string;
  full: string;
};

export function formatTimeframeLabel(timeframe: LiveTimeframe): string {
  if (timeframe === 'D') return '일봉';
  if (timeframe === 'W') return '주봉';
  if (timeframe === 'M') return '월봉';
  return `${timeframe.slice(0, -1)}분봉`;
}

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatChangePct(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatLiveViewLabel(
  nameOrCode: string,
  timeframe: LiveTimeframe | null | undefined,
  metrics?: LiveTabMetrics,
): string {
  return formatLiveViewLabelParts(nameOrCode, timeframe, metrics).full;
}

export function formatLiveViewLabelParts(
  nameOrCode: string,
  timeframe: LiveTimeframe | null | undefined,
  metrics?: LiveTabMetrics,
): LiveViewLabelParts {
  if (metrics !== undefined) {
    if (!finiteNumber(metrics.changePct)) return { primary: nameOrCode, full: nameOrCode };
    const detail = formatChangePct(metrics.changePct);
    return { primary: nameOrCode, detail, full: `${nameOrCode} ${detail}` };
  }
  const full = timeframe ? `${nameOrCode} ${formatTimeframeLabel(timeframe)}` : nameOrCode;
  return { primary: full, full };
}
