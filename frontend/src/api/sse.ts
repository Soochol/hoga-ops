import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiUrl } from './client';
import type { SSEEvent } from './types';

let _source: EventSource | null = null;
let _lastHeartbeatMs = 0;
const _subscribers = new Set<(e: SSEEvent) => void>();

async function open() {
  if (_source) return;
  const url = await apiUrl('/api/events');
  _source = new EventSource(url);
  _source.addEventListener('inventory_added', (e: MessageEvent) => emit({ type: 'inventory_added', ...JSON.parse(e.data) }));
  _source.addEventListener('inventory_removed', (e: MessageEvent) => emit({ type: 'inventory_removed', ...JSON.parse(e.data) }));
  _source.addEventListener('heartbeat', () => { _lastHeartbeatMs = Date.now(); });
  _source.addEventListener('error', () => emit({ type: 'heartbeat' })); // signal disruption
}

function emit(e: SSEEvent) { _subscribers.forEach(fn => fn(e)); }

export function lastHeartbeat(): number { return _lastHeartbeatMs; }

export function useEventStream() {
  const qc = useQueryClient();
  useEffect(() => {
    void open();
    const handler = (e: SSEEvent) => {
      if (e.type === 'inventory_added' || e.type === 'inventory_removed') {
        qc.invalidateQueries({ queryKey: ['stock-dates'] });
      }
    };
    _subscribers.add(handler);
    return () => { _subscribers.delete(handler); };
  }, [qc]);
}
