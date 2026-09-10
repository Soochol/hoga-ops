import { replaceEqualDeep, type QueryClient } from '@tanstack/react-query';
import type { QueueSnapshot } from '../api/types';

// Keep a push received before the first queue HTTP response, without inventing
// empty queue rows. Scoped to QueryClient so tests and app instances stay isolated.
const PERSISTENCE_KEY = ['capture', 'persistence'] as const;
type PersistenceState = Pick<QueueSnapshot,
  'persistence_degraded' | 'last_persisted_at_ms' | 'persistence_epoch' | 'persistence_revision'>;

function stateOf(value: PersistenceState): PersistenceState {
  return {
    persistence_degraded: value.persistence_degraded,
    last_persisted_at_ms: value.last_persisted_at_ms,
    persistence_epoch: value.persistence_epoch,
    persistence_revision: value.persistence_revision,
  };
}

function newest(current: PersistenceState | undefined, incoming: PersistenceState): PersistenceState {
  if (current?.persistence_epoch && current.persistence_epoch === incoming.persistence_epoch
    && (current.persistence_revision ?? 0) > (incoming.persistence_revision ?? 0)) return current;
  // A new server lifetime starts a fresh counter. Legacy servers have no epoch.
  return stateOf(incoming);
}

export function recordQueuePersistence(qc: QueryClient, incoming: PersistenceState): PersistenceState {
  const state = newest(qc.getQueryData<PersistenceState>(PERSISTENCE_KEY), incoming);
  qc.setQueryData(PERSISTENCE_KEY, state);
  return state;
}

/** A response from the old process can cross even the first WS connection.
 * Remember the epoch at request start so a newer push wins across that boundary. */
export async function readQueueSnapshot(
  qc: QueryClient, signal: AbortSignal, load: () => Promise<QueueSnapshot>,
): Promise<QueueSnapshot> {
  const startedEpoch = qc.getQueryData<PersistenceState>(PERSISTENCE_KEY)?.persistence_epoch;
  const snapshot = await load();
  signal.throwIfAborted();
  const current = qc.getQueryData<PersistenceState>(PERSISTENCE_KEY);
  const crossedEpoch = current?.persistence_epoch && current.persistence_epoch !== startedEpoch
    && current.persistence_epoch !== snapshot.persistence_epoch;
  const state = crossedEpoch ? current : recordQueuePersistence(qc, snapshot);
  return { ...snapshot, ...state };
}

export function shareQueueSnapshot(qc: QueryClient, oldData: unknown, newData: unknown): unknown {
  const incoming = newData as QueueSnapshot;
  const state = newest(qc.getQueryData<PersistenceState>(PERSISTENCE_KEY), incoming);
  return replaceEqualDeep(oldData, { ...incoming, ...state });
}
