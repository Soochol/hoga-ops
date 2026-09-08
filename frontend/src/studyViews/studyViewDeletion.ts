import { create } from 'zustand';
import type { QueryClient } from '@tanstack/react-query';
import { deleteStudyView, type StudyViewListRow, type StudyViewsFile } from '../api/studyViews';
import { STUDY_VIEW_SAVES_QUERY } from './studyViewKeys';
import { useLivePageStore } from '../state/livePage';

export const STUDY_DELETE_GRACE_MS = 5000;
interface DeleteBatch {
  id: number;
  rows: StudyViewListRow[];
  phase: 'pending' | 'deleting' | 'complete';
  deadline: number;
  failed: StudyViewListRow[];
  deleted: number;
  client: QueryClient;
}
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 0;
interface DeletionState {
  batches: DeleteBatch[];
  queue: (rows: StudyViewListRow[], client: QueryClient) => void;
  undo: (id: number) => void;
  dismiss: (id: number) => void;
  retry: (id: number) => void;
}
/** App-lifetime queue: switching panels never commits a deletion early. */
export const useStudyViewDeletion = create<DeletionState>((set, get) => ({
  batches: [],
  queue: (rows, client) => {
    const blocked = new Set(get().batches.filter((b) => b.phase !== 'complete').flatMap((b) => b.rows.map((r) => r.id)));
    const unique = [...new Map(rows.map((row) => [row.id, row])).values()].filter((row) => !blocked.has(row.id));
    if (!unique.length) return;
    const id = ++nextId;
    const batch: DeleteBatch = { id, rows: unique, client, phase: 'pending', deadline: Date.now() + STUDY_DELETE_GRACE_MS, failed: [], deleted: 0 };
    set((s) => ({ batches: [...s.batches, batch] }));
    timers.set(id, setTimeout(() => { timers.delete(id); void commit(batch); }, STUDY_DELETE_GRACE_MS));
  },
  undo: (id) => {
    if (!get().batches.some((b) => b.id === id && b.phase === 'pending')) return;
    clearTimeout(timers.get(id)); timers.delete(id);
    set((s) => ({ batches: s.batches.filter((b) => b.id !== id) }));
  },
  dismiss: (id) => set((s) => ({ batches: s.batches.filter((b) => b.id !== id || b.phase !== 'complete') })),
  retry: (id) => {
    const batch = get().batches.find((b) => b.id === id && b.phase === 'complete');
    if (!batch) return;
    get().dismiss(id);
    get().queue(batch.failed, batch.client);
  },
}));
async function commit(batch: DeleteBatch) {
  const store = useStudyViewDeletion;
  store.setState((s) => ({ batches: s.batches.map((b) => b.id === batch.id ? { ...b, phase: 'deleting' } : b) }));
  const failed: StudyViewListRow[] = [];
  const deleted = new Set<string>();
  // Bound concurrent requests when deleting a large selection.
  for (let i = 0; i < batch.rows.length; i += 4) {
    const chunk = batch.rows.slice(i, i + 4);
    const results = await Promise.allSettled(chunk.map(async (row) => {
      try { await deleteStudyView(row.id); }
      catch (error) {
        // Already removed in another window is the requested final state.
        if ((error as { status?: number })?.status !== 404) throw error;
      }
    }));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') deleted.add(chunk[index].id);
      else failed.push(chunk[index]);
    });
  }
  // Clear only a successfully deleted range. The stock/chart remains open.
  const page = useLivePageStore.getState();
  if (page.savedRangeFocus && deleted.has(page.savedRangeFocus.viewId)) page.clearSavedRange();
  await batch.client.cancelQueries({ queryKey: STUDY_VIEW_SAVES_QUERY });
  batch.client.setQueryData<StudyViewsFile>(STUDY_VIEW_SAVES_QUERY, (old) => old ? { ...old, saves: old.saves.filter((r) => !deleted.has(r.id)) } : old);
  store.setState((s) => ({ batches: s.batches.map((b) => b.id === batch.id ? { ...b, phase: 'complete', failed, deleted: deleted.size } : b) }));
  void batch.client.invalidateQueries({ queryKey: STUDY_VIEW_SAVES_QUERY });
  // Failures remain until acknowledged; successful notices expire.
  if (!failed.length) setTimeout(() => store.getState().dismiss(batch.id), 6000);
}
