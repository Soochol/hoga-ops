import type { PaneId } from './drawing/types';
import { formatKoreanWonAmount } from '../util/koreanNumber';

// lightweight-charts caps series values at Number.MAX_SAFE_INTEGER / 100,
// even with custom minMove. Plot turnover in eok (100 million KRW), while
// bundle data and persisted drawing coordinates remain in KRW.
export const TRADE_VALUE_WON_PER_UNIT = 100_000_000;

export function paneValueToSeriesValue(paneId: PaneId, value: number): number {
  return paneId === 'trade-value' ? value / TRADE_VALUE_WON_PER_UNIT : value;
}

export function seriesValueToPaneValue(paneId: PaneId, value: number): number {
  return paneId === 'trade-value' ? value * TRADE_VALUE_WON_PER_UNIT : value;
}

export function formatTradeValueSeriesValue(value: number): string {
  return formatKoreanWonAmount(seriesValueToPaneValue('trade-value', value));
}
