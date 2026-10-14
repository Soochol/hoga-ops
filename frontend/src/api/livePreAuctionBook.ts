import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import type { OrderbookResponse, OrderbookSnapshot } from './types';
import { regularSessionCloseMs, regularSessionOpenMs } from '../live/liveDateTime';

export function preAuctionCutoff(date: string): number {
  return regularSessionCloseMs(date) - 10 * 60_000;
}

export function hasBookPrices(snapshot: OrderbookSnapshot | null | undefined): snapshot is OrderbookSnapshot {
  return snapshot != null && (snapshot.ask.some(level => Number.isFinite(level.price) && level.price > 0)
    || snapshot.bid.some(level => Number.isFinite(level.price) && level.price > 0));
}

/** Saved display fallback only; this query never calls a broker. */
export function useLivePreAuctionBook(code: string, date: string, enabled: boolean) {
  const cutoff = preAuctionCutoff(date);
  return useQuery({
    queryKey: ['live', 'pre-auction-book', code, date, 'KRX'],
    queryFn: async ({ signal }) => {
      const response = await apiCall<OrderbookResponse>(
        `/api/orderbook?code=${encodeURIComponent(code)}&date=${date}&venue=KRX&t=${cutoff - 1}`, { signal },
      );
      const snapshot = response.snapshot;
      return hasBookPrices(snapshot) && snapshot.ts_ms >= regularSessionOpenMs(date) && snapshot.ts_ms < cutoff
        ? snapshot : null;
    },
    enabled,
    staleTime: query => query.state.data ? Infinity : 0,
    // Promotion may still be writing the regular session when the gap starts.
    refetchInterval: query => query.state.data ? false : 30_000,
    retry: 1,
  });
}
