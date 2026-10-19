import type { CandleOptions, ScreenerTimeframe } from '../api/screener';

export const CHANGE_REFERENCE_LABELS = {
  previous_day: '전일 종가 대비', previous_bar: '직전 봉 종가 대비', bar_open: '해당 봉 시가 대비',
};

export function timeframeLabel(timeframe: ScreenerTimeframe = 'D'): string {
  return timeframe.endsWith('m') ? `${timeframe.slice(0, -1)}분봉`
    : ({ D: '일봉', W: '주봉', M: '월봉' }[timeframe as 'D' | 'W' | 'M']);
}

export function candleSummary(params: CandleOptions, summary: string): string {
  return `${timeframeLabel(params.timeframe)} · ${summary}`;
}

export const volumeTimeframeLabel = (timeframe: ScreenerTimeframe) =>
  timeframe.endsWith('m') ? `${timeframe.slice(0, -1)}분` : ({ D: '일', W: '주', M: '월' }[timeframe as 'D' | 'W' | 'M']);
