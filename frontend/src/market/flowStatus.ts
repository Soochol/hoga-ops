import type { FlowCollection, FlowHealth } from '../api/market';

export function flowStatus(collection: FlowCollection, health: FlowHealth, elapsedMs: number) {
  const now = collection.server_now_ms + elapsedMs;
  const anchor = health.last_success_at_ms ?? health.waiting_since_ms;
  if (collection.collection_expected && anchor != null &&
      (health.status === 'receiving' || health.status === 'waiting') &&
      now - anchor > collection.stale_after_ms) return 'delayed';
  return health.status;
}

