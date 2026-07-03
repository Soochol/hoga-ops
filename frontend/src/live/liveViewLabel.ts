import type { LiveTimeframe } from '../state/livePage';

export type LiveTabMetrics = {
  changePct?: number | null;
  ratioX?: number | null;
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

function formatRatioX(value: number): string {
  return `${value.toFixed(2)}x`;
}

export function formatLiveViewLabel(
  nameOrCode: string,
  timeframe: LiveTimeframe | null | undefined,
  metrics?: LiveTabMetrics,
): string {
  if (metrics !== undefined) {
    if (!finiteNumber(metrics.changePct)) return nameOrCode;
    const ratioSuffix = finiteNumber(metrics.ratioX) && metrics.ratioX > 0
      ? ` · ${formatRatioX(metrics.ratioX)}`
      : '';
    return `${nameOrCode} ${formatChangePct(metrics.changePct)}${ratioSuffix}`;
  }
  return timeframe ? `${nameOrCode} ${formatTimeframeLabel(timeframe)}` : nameOrCode;
}
