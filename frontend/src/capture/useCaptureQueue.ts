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

/** capture_finished 무효화를 접는 창(ms).
 *
 *  왜 필요한가: GET /queue 는 `done` 버킷 **전체**를 돌려주고(captures.py
 *  get_queue_snapshot), `_done` 은 DELETE /done 전까지 계속 자란다. 완료 1건마다
 *  무효화하면 N 건짜리 백필이 크기 1,2,…,N 인 응답을 N 번 받는다 — 전송량이
 *  O(N²) 다. 완료 이벤트는 워커 수만큼 몰려 오므로 짧은 창으로도 대부분 접힌다.
 *
 *  250ms 인 이유: 사람이 "즉시" 로 느끼는 상한 안이면서(목록이 늦게 갱신되는
 *  느낌을 주지 않는다) 동시 워커(기본 3)의 완료 버스트를 한 번으로 모으기에
 *  충분하다. 진행률·단계 이벤트는 여기 해당하지 않는다 — 그쪽은 이미
 *  setQueryData 로 지역 패치라 네트워크를 타지 않는다. */
const FINISHED_INVALIDATE_COALESCE_MS = 250;

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
    // 접기 타이머. 창 안에 몰린 capture_finished 는 한 번의 무효화로 합쳐진다.
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    const invalidateQueueCoalesced = (): void => {
      if (coalesceTimer !== null) return;   // 이미 예약됨 — 창이 끝날 때 한 번만 돈다
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY });
      }, FINISHED_INVALIDATE_COALESCE_MS);
    };

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
        // 접어서 보낸다 — 캘린더 셀 패치는 아래에서 이벤트마다 그대로 적용되므로
        // 사용자가 보는 즉각적 피드백(달력 색)은 지연되지 않는다. 지연되는 것은
        // 큐 목록의 버킷 재배치뿐이고, 그건 250ms 안에 따라온다.
        invalidateQueueCoalesced();
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
    return () => {
      unsub();
      // 예약된 무효화를 취소한다. 남겨 두면 구독 해제 뒤에도 한 번 더 발사돼,
      // 언마운트된 트리를 위해 쓸모없는 fetch 를 한다(테스트에서는 이게
      // "act 밖 업데이트" 경고로 나타난다).
      if (coalesceTimer !== null) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
    };
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
    isError: queue.isError,
    refetchQueue: queue.refetch,
    addItems: addItemsM,
    cancelItem: cancelItemM,
    cancelAll: cancelAllM,
    dismissDone: dismissDoneM,
    resumeQueue: resumeQueueM,
    retryItems: retryItemsM,
  };
}
