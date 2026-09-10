import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { QueueSnapshot } from '../api/types';
import { readQueueSnapshot, recordQueuePersistence, shareQueueSnapshot } from './queuePersistence';

function snapshot(revision: number, degraded: boolean, epoch = 'server-a'): QueueSnapshot {
  return { active: [], queued: [], done: [], paused: false, max_concurrent: 3,
    persistence_degraded: degraded, last_persisted_at_ms: 100,
    persistence_epoch: epoch, persistence_revision: revision };
}

describe('queue persistence ordering', () => {
  it('keeps failure push ahead of an older HTTP response while accepting queue rows', () => {
    const qc = new QueryClient();
    recordQueuePersistence(qc, snapshot(2, true));
    const http = { ...snapshot(1, false), paused: true };
    const merged = shareQueueSnapshot(qc, undefined, http) as QueueSnapshot;
    expect(merged.persistence_degraded).toBe(true);
    expect(merged.persistence_revision).toBe(2);
    expect(merged.paused).toBe(true);
    qc.clear();
  });

  it('retains recovery despite a reordered failure push and accepts a new server counter', () => {
    const qc = new QueryClient();
    recordQueuePersistence(qc, snapshot(3, false));
    expect(recordQueuePersistence(qc, snapshot(2, true)).persistence_degraded).toBe(false);
    const rebooted = recordQueuePersistence(qc, snapshot(0, true, 'server-b'));
    expect(rebooted.persistence_revision).toBe(0);
    expect(rebooted.persistence_epoch).toBe('server-b');
    expect(rebooted.persistence_degraded).toBe(true);
    qc.clear();
  });
});


it('keeps a new process push when an old process HTTP response crosses the first connection', async () => {
  const qc = new QueryClient();
  let respond!: (s: QueueSnapshot) => void;
  const delayed = new Promise<QueueSnapshot>((resolve) => { respond = resolve; });
  const read = readQueueSnapshot(qc, new AbortController().signal, () => delayed);
  recordQueuePersistence(qc, snapshot(1, true, 'new-process'));
  respond(snapshot(20, false, 'old-process'));
  expect((await read).persistence_epoch).toBe('new-process');
  expect((await read).persistence_degraded).toBe(true);
  qc.clear();
});

it('ignores a cancelled request before it can replace the persistence metadata', async () => {
  const qc = new QueryClient();
  const controller = new AbortController();
  controller.abort();
  await expect(readQueueSnapshot(qc, controller.signal, async () => snapshot(99, false))).rejects.toBeDefined();
  expect(recordQueuePersistence(qc, snapshot(1, true)).persistence_degraded).toBe(true);
  qc.clear();
});
