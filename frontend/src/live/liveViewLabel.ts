import type { LiveTimeframe } from '../state/livePage';

export function formatTimeframeLabel(timeframe: LiveTimeframe): string {
  if (timeframe === 'D') return '일봉';
  if (timeframe === 'W') return '주봉';
  if (timeframe === 'M') return '월봉';
  return `${timeframe.slice(0, -1)}분봉`;
}

export function formatLiveViewLabel(nameOrCode: string, timeframe: LiveTimeframe | null | undefined): string {
  return timeframe ? `${nameOrCode} ${formatTimeframeLabel(timeframe)}` : nameOrCode;
}
