import { create } from 'zustand';

/** Client-side set of QueueItem ids that were enqueued via inventory
 *  re-capture (vs. CaptureForm). Drives the `inventory` badge on
 *  CaptureQueueRow. Per the spec, this lives entirely in memory — page
 *  reload loses the set, which is acceptable for a single-user local tool. */
export interface OriginsState {
  ids: Set<string>;
  add: (newIds: string[]) => void;
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
  has: (id) => get().ids.has(id),
  clear: () => set({ ids: new Set() }),
}));
