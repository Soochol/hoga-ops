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
    src.addEventListener('capture_progress', (e: MessageEvent) =>
      emit({ type: 'capture_progress', ...JSON.parse(e.data) }),
    );
    src.addEventListener('capture_phase', (e: MessageEvent) =>
      emit({ type: 'capture_phase', ...JSON.parse(e.data) }),
    );
    src.addEventListener('capture_finished', (e: MessageEvent) =>
      emit({ type: 'capture_finished', ...JSON.parse(e.data) }),
    );
    src.addEventListener('capture_queued', (e: MessageEvent) =>
      emit({ type: 'capture_queued', ...JSON.parse(e.data) }),
    );
    src.addEventListener('capture_queue_paused', (e: MessageEvent) =>
      emit({ type: 'capture_queue_paused', ...JSON.parse(e.data) }),
    );
    src.addEventListener('capture_queue_resumed', (e: MessageEvent) =>
      emit({ type: 'capture_queue_resumed', ...JSON.parse(e.data) }),
    );
    src.addEventListener('capture_queue_drained', (e: MessageEvent) =>
      emit({ type: 'capture_queue_drained', ...JSON.parse(e.data) }),
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
      } else if (e.type === 'disconnected') {
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
      }
    };
    _subscribers.add(handler);
    return () => {
      _subscribers.delete(handler);
    };
  }, [qc]);
}

export function subscribeToCaptureEvents(handler: (e: SSEEvent) => void): () => void {
  // Ensure the EventSource is open even if only a capture page mounts this hook.
  void open();
  const wrapped = (e: SSEEvent) => {
    if (
      e.type === 'capture_progress' ||
      e.type === 'capture_phase' ||
      e.type === 'capture_finished' ||
      e.type === 'capture_queued' ||
      e.type === 'capture_queue_paused' ||
      e.type === 'capture_queue_resumed' ||
      e.type === 'capture_queue_drained'
    ) {
      handler(e);
    }
  };
  _subscribers.add(wrapped);
  return () => {
    _subscribers.delete(wrapped);
  };
}
