import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';
import type { MarketIndexQuote } from './marketIndexQuotes';
import { isUsIndexId, type LiveIndexId } from '../live/liveInstrument';
import { realMsToYyyymmdd, regularSessionCloseMs, regularSessionOpenMs } from '../live/liveDateTime';

export type IndexQuoteSession = 'open' | 'closed' | 'unknown';
export type IndexQuoteRefresh = 'normal' | 'stale' | 'error' | 'unconfigured' | 'bypass' | 'partial';

/** Exact mirror of IndexHeaderQuoteResponse. Daily anchors are not quote times. */
export interface IndexHeaderQuoteResponse {
  index_id: string;
  value: number | null;
  change: number | null;
  change_rate: number | null;
  previous_close: number | null;
  trading_date: string | null;
  observed_at_ms: number | null;
  checked_at_ms: number | null;
  market_timezone: string;
  session_status: IndexQuoteSession;
  refresh_status: IndexQuoteRefresh;
  source: string;
  delay_unverified: boolean;
}

export const indexHeaderQuoteKey = (id: LiveIndexId | null) => ['live', 'index-header-quote', id] as const;

export function useIndexHeaderQuote(id: LiveIndexId, now: number) {
  const qc = useQueryClient();
  const key = indexHeaderQuoteKey(id);
  const request = async (signal: AbortSignal, retry = false) => {
    const response = await apiCall<IndexHeaderQuoteResponse>(
      `/api/live/index-header-quote?index_id=${id}${retry ? '&retry=true' : ''}`, { signal },
    );
    if (response.index_id !== id) throw new Error('지수 시세의 식별자가 일치하지 않습니다.');
    const previous = qc.getQueryData<IndexHeaderQuoteResponse>(key);
    if (response.value == null && response.refresh_status !== 'normal' && previous?.index_id === id
      && previous.value != null) {
      return { ...previous, refresh_status: response.refresh_status };
    }
    // A failed baseline refresh cannot erase a previously verified close for
    // this SAME trading day. Never carry yesterday's baseline into a new day.
    if (response.value != null && response.previous_close == null && response.refresh_status !== 'normal'
      && previous?.index_id === id && previous.trading_date === response.trading_date
      && response.trading_date != null && previous.previous_close != null && previous.previous_close > 0) {
      const change = response.value - previous.previous_close;
      return { ...response, previous_close: previous.previous_close, change,
        change_rate: change / previous.previous_close * 100 };
    }
    return response;
  };
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => request(signal),
    staleTime: 20_000,
    refetchInterval: isUsIndexId(id) ? 60_000 : 30_000,
    refetchOnWindowFocus: true,
    retry: false,
    // A changed subject always gets its own data, including while a request is pending.
    placeholderData: undefined,
  });
  // Subscribe to the market bar's WS cache without starting another REST poll.
  const live = useQuery<MarketIndexQuote[]>({ queryKey: ['market-index-quotes'], queryFn: skipToken });
  const tick = !isUsIndexId(id) ? live.data?.find(q => q.id === id) : undefined;
  let data = query.data?.index_id === id ? query.data : undefined;
  // Compare observations when their dates are known, otherwise use the last
  // successful check. Keep value, percent and baseline on the same snapshot.
  if (data && tick && tick.tMs > (data.observed_at_ms ?? data.checked_at_ms ?? Infinity) && tick.tMs <= now + 120_000
    && realMsToYyyymmdd(tick.tMs) === realMsToYyyymmdd(now)
    && Number.isFinite(tick.value) && tick.value > 0 && Number.isFinite(tick.change) && Number.isFinite(tick.changeRate)) {
    const day = realMsToYyyymmdd(tick.tMs);
    data = { ...data, value: tick.value, change: tick.change, change_rate: tick.changeRate,
      previous_close: Math.round((tick.value - tick.change) * 100) / 100,
      trading_date: day, observed_at_ms: tick.tMs,
      session_status: tick.tMs >= regularSessionOpenMs(day) && tick.tMs < regularSessionCloseMs(day) ? 'open' : 'closed',
      checked_at_ms: tick.tMs, refresh_status: 'normal', source: 'kiwoom_ws' };
  }
  return { ...query, data, retryQuote: () => qc.fetchQuery({
    queryKey: key, queryFn: ({ signal }) => request(signal, true), staleTime: 0, retry: false,
  }) };
}
