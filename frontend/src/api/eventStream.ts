import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { STOCK_DATES_QUERY_KEY } from './stock-dates';
import { subscribeEvents, lastHeartbeat } from './ws';
import type { SSEEvent } from './types';

export { lastHeartbeat };

export function useEventStream(): void {
  const qc = useQueryClient();
  useEffect(() => {
    return subscribeEvents((e: SSEEvent) => {
      if (e.type === 'inventory_added' || e.type === 'inventory_removed') {
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
      } else if (e.type === 'disconnected') {
        // Reconnect recovery (once per disconnect transition; ADR-0019).
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
        qc.invalidateQueries({ queryKey: ['capture', 'queue'] });
        qc.invalidateQueries({
          predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'calendar',
        });
      }
      // 'connected' → no query work; UI surfaces use it.
    });
  }, [qc]);
}

export function subscribeToCaptureEvents(handler: (e: SSEEvent) => void): () => void {
  return subscribeEvents((e: SSEEvent) => {
    if (
      e.type === 'capture_progress' ||
      e.type === 'capture_phase' ||
      e.type === 'capture_finished' ||
      e.type === 'capture_queued' ||
      e.type === 'capture_dismissed' ||
      e.type === 'capture_queue_paused' ||
      e.type === 'capture_queue_resumed' ||
      e.type === 'capture_queue_drained' ||
      e.type === 'capture_timing'
    ) {
      handler(e);
    }
  });
}
