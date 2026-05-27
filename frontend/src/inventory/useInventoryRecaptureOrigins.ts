import { useEffect } from 'react';
import { create } from 'zustand';
import { subscribeToCaptureEvents } from '../api/sse';

/** Client-side set of QueueItem ids that were enqueued via inventory
 *  re-capture (vs. CaptureForm). Drives the `inventory` badge on
 *  CaptureQueueRow. Per the spec, this lives entirely in memory — page
 *  reload loses the set, which is acceptable for a single-user local tool.
 *
 *  Within a session, ids are pruned on `capture_dismissed` (the only event
 *  that removes a QueueItem from the queue snapshot). Without pruning, ids
 *  accumulated monotonically — see review finding 2026-05-27. */
export interface OriginsState {
  ids: Set<string>;
  add: (newIds: string[]) => void;
  remove: (ids: string[]) => void;
  has: (id: string) => boolean;
  clear: () => void;
}

export const useInventoryRecaptureOrigins = create<OriginsState>((set, get) => ({
  ids: new Set(),
  add: (newIds) => {
    if (newIds.length === 0) return;
    set((s) => {
      const next = new Set(s.ids);
      for (const id of newIds) next.add(id);
      return { ids: next };
    });
  },
  remove: (ids) => {
    if (ids.length === 0) return;
    set((s) => {
      // Only allocate a new Set if at least one id is actually present —
      // dismissed-event payloads for non-inventory items would otherwise
      // trigger a no-op re-render of every consumer.
      const hit = ids.some((id) => s.ids.has(id));
      if (!hit) return s;
      const next = new Set(s.ids);
      for (const id of ids) next.delete(id);
      return { ids: next };
    });
  },
  has: (id) => get().ids.has(id),
  clear: () => set({ ids: new Set() }),
}));

/** Mount once at the app root: prunes origin ids when their QueueItems are
 *  dismissed (the only SSE event that removes ids from the snapshot). */
export function useInventoryRecaptureOriginsCleanup(): void {
  useEffect(() => {
    const unsub = subscribeToCaptureEvents((e) => {
      if (e.type === 'capture_dismissed') {
        useInventoryRecaptureOrigins.getState().remove(e.item_ids);
      }
    });
    return unsub;
  }, []);
}
