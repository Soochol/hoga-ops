import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addItems, getQueue, cancelItem, cancelAll, resumeQueue, dismissDone, retryItems,
} from '../api/captures';
import { subscribeToCaptureEvents } from '../api/eventStream';
import {
  CALENDAR_QUERY_KEY,
  applyCellPatch,
  type EnrichedCalendarResponse,
} from './useCalendar';
import { phaseToCalendarStatus } from './phase';
import { useCaptureTimings } from './timing/useCaptureTimings';
import type { QueueItem, QueueSnapshot, PushEvent } from '../api/types';

export const CAPTURE_QUEUE_QUERY_KEY = ['capture', 'queue'] as const;

/** Shared mutationKey so cross-component consumers (CaptureQueue's dedupe banner
 *  reads what CaptureForm submitted) can subscribe via React Query's
 *  `useMutationState`. */
export const ADD_ITEMS_MUTATION_KEY = ['captures', 'addItems'] as const;

/** Pure helper: replace the QueueItem matching `item_id` across active/queued/done
 *  with a shallow merge of `patch`. Returns the prior snapshot reference unchanged
 *  if no item matches (so React Query's reference equality short-circuits re-renders). */
export function patchQueueItem(
  snap: QueueSnapshot,
  itemId: string,
  patch: Partial<QueueItem>,
): QueueSnapshot {
  const apply = (list: QueueItem[]): { changed: boolean; list: QueueItem[] } => {
    const idx = list.findIndex((i) => i.item_id === itemId);
    if (idx === -1) return { changed: false, list };
    const next = list.slice();
    next[idx] = { ...next[idx], ...patch };
    return { changed: true, list: next };
  };
  const a = apply(snap.active);
  const q = apply(snap.queued);
  const d = apply(snap.done);
  if (!a.changed && !q.changed && !d.changed) return snap;
  return { ...snap, active: a.list, queued: q.list, done: d.list };
}

function yearOf(date8: string): number { return parseInt(date8.slice(0, 4), 10); }
function monthOf(date8: string): number { return parseInt(date8.slice(4, 6), 10); }

/** Single owner of the capture-queue push subscription. Mount EXACTLY ONCE at
 *  the app root (App.tsx) alongside useEventStream / the origins cleanup hook.
 *
 *  Previously this subscription lived inside useCaptureQueue, which is mounted
 *  by ~5 components (CaptureInlineStatus in the always-on top nav, CaptureForm,
 *  CaptureQueue, StockDateGroupDetail, useInventoryRecapture). The shared
 *  /api/ws connection was already a singleton (ADR-0053), but each mount
 *  registered its own capture-event callback, so every push ran N identical
 *  setQueryData reducers — idempotent (one shared cache key) but wasteful.
 *  The read side (useCaptureQueue) now only reads the cache; this hook owns
 *  the writes. */
export function useCaptureQueueSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const unsub = subscribeToCaptureEvents((e: PushEvent) => {
      if (e.type === 'capture_progress') {
        qc.setQueryData<QueueSnapshot>(CAPTURE_QUEUE_QUERY_KEY, (prev) =>
          prev ? patchQueueItem(prev, e.item_id, { progress: e.progress, phase: e.phase }) : prev,
        );
      } else if (e.type === 'capture_phase') {
        qc.setQueryData<QueueSnapshot>(CAPTURE_QUEUE_QUERY_KEY, (prev) =>
          prev ? patchQueueItem(prev, e.item_id, { phase: e.phase }) : prev,
        );
      } else if (e.type === 'capture_finished') {
        // Refetch the queue (state moved across active/done buckets).
        qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY });
        // Patch the calendar cell for (e.code, e.date) without refetching the month.
        const key = CALENDAR_QUERY_KEY(e.code, yearOf(e.date), monthOf(e.date));
        const status = phaseToCalendarStatus(e.phase, e.skip_reason);
        if (status !== null) {
          qc.setQueryData<EnrichedCalendarResponse>(key, (prev) =>
            prev ? applyCellPatch(prev, e.date, { status }, Date.now()) : prev,
          );
        }
      } else if (e.type === 'capture_dismissed') {
        qc.setQueryData<QueueSnapshot>(CAPTURE_QUEUE_QUERY_KEY, (prev) => {
          if (!prev) return prev;
          const ids = new Set(e.item_ids);
          // Array.prototype.filter ALWAYS returns a new array, which would
          // defeat React Query's reference-equality short-circuit. Only build
          // a new array for buckets that actually had a matching id.
          const filterIfNeeded = (list: QueueItem[]): QueueItem[] => {
            const hasMatch = list.some((i) => ids.has(i.item_id));
            return hasMatch ? list.filter((i) => !ids.has(i.item_id)) : list;
          };
          const active = filterIfNeeded(prev.active);
          const queued = filterIfNeeded(prev.queued);
          const done = filterIfNeeded(prev.done);
          if (active === prev.active && queued === prev.queued && done === prev.done) {
            return prev;
          }
          return { ...prev, active, queued, done };
        });
      } else if (
        e.type === 'capture_queued' ||
        e.type === 'capture_queue_paused' ||
        e.type === 'capture_queue_resumed' ||
        e.type === 'capture_queue_drained'
      ) {
        qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY });
      } else if (e.type === 'capture_timing') {
        useCaptureTimings.getState().upsert(e.id, e.summary);
      }
    });
    return unsub;
  }, [qc]);
}

/** Read the capture queue + expose its mutations. Safe to mount in any number
 *  of components — the useQuery shares one cache entry (CAPTURE_QUEUE_QUERY_KEY)
 *  and the push subscription that keeps it fresh is owned by useCaptureQueueSync
 *  at the app root. */
export function useCaptureQueue() {
  const qc = useQueryClient();
  const queue = useQuery<QueueSnapshot>({
    queryKey: CAPTURE_QUEUE_QUERY_KEY,
    queryFn: getQueue,
    staleTime: 0,
  });

  const addItemsM = useMutation({
    mutationKey: ADD_ITEMS_MUTATION_KEY,
    mutationFn: addItems,
    // Invalidate rather than setQueryData — see spec §4.3 race rationale.
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });
  const cancelItemM = useMutation({
    mutationFn: cancelItem,
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });
  const cancelAllM = useMutation({
    mutationFn: cancelAll,
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });
  const dismissDoneM = useMutation({
    mutationFn: dismissDone,
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });
  const resumeQueueM = useMutation({
    mutationFn: resumeQueue,
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });
  const retryItemsM = useMutation({
    mutationFn: retryItems,
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });

  return {
    queue: queue.data,
    isLoading: queue.isLoading,
    addItems: addItemsM,
    cancelItem: cancelItemM,
    cancelAll: cancelAllM,
    dismissDone: dismissDoneM,
    resumeQueue: resumeQueueM,
    retryItems: retryItemsM,
  };
}
