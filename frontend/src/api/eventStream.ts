import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { STOCK_DATES_QUERY_KEY } from './stock-dates';
import { subscribeEvents, lastHeartbeat } from './ws';
import type { PushEvent } from './types';
import { markPromotion } from '../state/livePromotion';

export { lastHeartbeat };

export function useEventStream(): void {
  const qc = useQueryClient();
  useEffect(() => {
    return subscribeEvents((e: PushEvent) => {
      if (e.type === 'inventory_added' || e.type === 'inventory_removed') {
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
      } else if (e.type === 'promotion_completed') {
        // Delta today-range hooks refresh via the per-code stamp; simple
        // useRange consumers via invalidate (WS 푸시 승격 무효화).
        markPromotion(e.code, Date.now());
        qc.invalidateQueries({
          predicate: (q) =>
            Array.isArray(q.queryKey) && q.queryKey[0] === 'range' && q.queryKey[1] === e.code,
        });
      } else if (e.type === 'disconnected') {
        // Reconnect recovery (once per disconnect transition; ADR-0019).
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
        qc.invalidateQueries({ queryKey: ['capture', 'queue'] });
        qc.invalidateQueries({
          predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'calendar',
        });
        // Promotions may have been missed while disconnected. The delta hooks'
        // 5-min fallback poll is the real safety net; this refreshes enabled/
        // simple range queries immediately on reconnect.
        qc.invalidateQueries({
          predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'range',
        });
      }
      // 'connected' → no query work; UI surfaces use it.
    });
  }, [qc]);
}

export function subscribeToCaptureEvents(handler: (e: PushEvent) => void): () => void {
  return subscribeEvents((e: PushEvent) => {
    if (e.type.startsWith('capture_')) handler(e);
  });
}

/** 스크리너 갱신 job 이벤트 + disconnected(재연결 복구용) 필터. */
export function subscribeToScreenerUpdateEvents(handler: (e: PushEvent) => void): () => void {
  return subscribeEvents((e: PushEvent) => {
    if (e.type.startsWith('screener_update') || e.type === 'disconnected') handler(e);
  });
}
