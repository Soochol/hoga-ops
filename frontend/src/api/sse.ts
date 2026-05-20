import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiUrl } from './client';
import { STOCK_DATES_QUERY_KEY } from './stock-dates';
import type { SSEEvent } from './types';

let _source: EventSource | null = null;
let _opening = false;
let _lastHeartbeatMs = 0;
const _subscribers = new Set<(e: SSEEvent) => void>();

async function open() {
  if (_source || _opening) return;
  _opening = true;
  try {
    const url = await apiUrl('/api/events');
    if (_source) return; // another caller won the race
    const src = new EventSource(url);
    src.addEventListener('inventory_added', (e: MessageEvent) =>
      emit({ type: 'inventory_added', ...JSON.parse(e.data) }),
    );
    src.addEventListener('inventory_removed', (e: MessageEvent) =>
      emit({ type: 'inventory_removed', ...JSON.parse(e.data) }),
    );
    src.addEventListener('heartbeat', () => {
      _lastHeartbeatMs = Date.now();
      emit({ type: 'heartbeat' });
    });
    src.addEventListener('error', () => emit({ type: 'disconnected' }));
    _source = src;
  } finally {
    _opening = false;
  }
}

function emit(e: SSEEvent) {
  _subscribers.forEach((fn) => fn(e));
}

export function lastHeartbeat(): number {
  return _lastHeartbeatMs;
}

export function __resetForTests(): void {
  _source?.close();
  _source = null;
  _opening = false;
  _lastHeartbeatMs = 0;
  _subscribers.clear();
}

export function useEventStream() {
  const qc = useQueryClient();
  useEffect(() => {
    void open();
    const handler = (e: SSEEvent) => {
      if (e.type === 'inventory_added' || e.type === 'inventory_removed') {
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
      }
    };
    _subscribers.add(handler);
    return () => {
      _subscribers.delete(handler);
    };
  }, [qc]);
}
