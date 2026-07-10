import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

import { apiCall } from './client';
import { realMsToYyyymmdd } from '../live/liveDateTime';

export interface ScreenerDailyCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 일봉 candles 중 `date`(YYYYMMDD) **직전 거래일**의 close = 그 date 기준 전일 종가.
 *  date 미만(strictly <) 중 최댓날짜를 고르므로 캔들 정렬 순서·주말/공휴일 갭과 무관.
 *  해당 종목/기간에 이전 거래일 캔들이 없으면 null. */
export function prevCloseBeforeDate(candles: ScreenerDailyCandle[], date: string): number | null {
  let bestDate = '';
  let close: number | null = null;
  for (const c of candles) {
    const d = realMsToYyyymmdd(c.t_ms);
    if (d < date && d > bestDate) {
      bestDate = d;
      close = c.close;
    }
  }
  return close;
}

export interface ScreenerDailyCandlesResponse {
  code: string;
  from: string;
  to: string;
  source: 'screener_daily';
  candles: ScreenerDailyCandle[];
  data_warnings: Array<{ batch: string; reason: string; msg: string }>;
}

export type ScreenerDailyCandlesQueryKey = readonly [
  'live',
  'screener-daily-candles',
  string | null,
  string | null,
  string | null,
];

export function screenerDailyCandlesQueryOptions(
  code: string | null,
  from: string | null,
  to: string | null,
): UseQueryOptions<
  ScreenerDailyCandlesResponse,
  Error,
  ScreenerDailyCandlesResponse,
  ScreenerDailyCandlesQueryKey
> {
  const enabled = !!(code && from && to && from <= to);
  return {
    queryKey: ['live', 'screener-daily-candles', code, from, to] as const,
    queryFn: ({ signal }) =>
      apiCall<ScreenerDailyCandlesResponse>(
        `/api/live/screener-daily-candles?code=${code}&from=${from}&to=${to}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  };
}

export function useScreenerDailyCandles(
  code: string | null,
  from: string | null,
  to: string | null,
) {
  return useQuery(screenerDailyCandlesQueryOptions(code, from, to));
}
