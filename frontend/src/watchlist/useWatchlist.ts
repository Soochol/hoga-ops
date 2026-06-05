import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { WATCHLIST_KEY } from './watchlistKeys';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  catchupNow,
  catchupAll,
  createFolder,
  renameFolder,
  deleteFolder,
  reorderFolders,
  moveEntries,
  reorderEntries,
  removeEntries,
  type WatchlistResponse,
  type EnqueueResponse,
  type ManualCatchupAllResponse,
} from '../api/watchlist';

export function useWatchlist() {
  return useQuery<WatchlistResponse>({
    queryKey: WATCHLIST_KEY,
    queryFn: getWatchlist,
    refetchInterval: 60_000,  // refresh the countdown source minute-ly
  });
}

export function useAddToWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['watchlist', 'add'],
    mutationFn: (code: string) => addToWatchlist(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}

export function useRemoveFromWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['watchlist', 'remove'],
    mutationFn: (code: string) => removeFromWatchlist(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}

export function useCatchupOne() {
  const qc = useQueryClient();
  return useMutation<EnqueueResponse, Error, string>({
    mutationKey: ['watchlist', 'catchup-one'],
    mutationFn: (code: string) => catchupNow(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}

export function useCatchupAll() {
  const qc = useQueryClient();
  return useMutation<ManualCatchupAllResponse, Error, void>({
    mutationKey: ['watchlist', 'catchup-all'],
    mutationFn: () => catchupAll(),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}

// --- folder CRUD: invalidate-only (consistent with add/remove) ---
export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createFolder(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
export function useRenameFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { folderId: string; name: string }) => renameFolder(v.folderId, v.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (folderId: string) => deleteFolder(folderId),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}

// --- move / reorder: optimistic + rollback (DnD smoothness) ---
type ReorderVars = { folderId: string | null; orderedCodes: string[] };
type MoveVars = { codes: string[]; folderId: string | null };

// no-jump invariant: 서버가 target 그룹을 0..N-1로 compact 유지하므로(_reindex), 아래 낙관적
// order는 invalidate 후 서버 값과 같은 *상대순서*에 안착 → 화면 jump 없음. 렌더는 .order로
// 정렬하므로 절대값 차이는 무해. (이 불변식이 깨지면 낙관적 업데이트가 깜빡일 수 있으니 유지.)
function applyReorder(data: WatchlistResponse, v: ReorderVars): WatchlistResponse {
  const rank = new Map(v.orderedCodes.map((c, i) => [c, i] as const));
  return {
    ...data,
    entries: data.entries.map((e) =>
      e.folder_id === v.folderId && rank.has(e.code)
        ? { ...e, order: rank.get(e.code)! } : e),
  };
}
function applyMove(data: WatchlistResponse, v: MoveVars): WatchlistResponse {
  const base = Math.max(-1, ...data.entries.filter((e) => e.folder_id === v.folderId).map((e) => e.order)) + 1;
  const set = new Set(v.codes);
  return {
    ...data,
    entries: data.entries.map((e) =>
      set.has(e.code) ? { ...e, folder_id: v.folderId, order: base + v.codes.indexOf(e.code) } : e),
  };
}

function useOptimisticEntryMutation<V>(
  mutationFn: (v: V) => Promise<void>,
  apply: (d: WatchlistResponse, v: V) => WatchlistResponse,
) {
  const qc = useQueryClient();
  return useMutation<void, Error, V, { prev?: WatchlistResponse }>({
    mutationFn,
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: WATCHLIST_KEY });
      const prev = qc.getQueryData<WatchlistResponse>(WATCHLIST_KEY);
      if (prev) qc.setQueryData(WATCHLIST_KEY, apply(prev, v));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(WATCHLIST_KEY, ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}

export function useReorderEntries() {
  return useOptimisticEntryMutation<ReorderVars>(
    (v) => reorderEntries(v.folderId, v.orderedCodes), applyReorder);
}
export function useMoveEntries() {
  return useOptimisticEntryMutation<MoveVars>(
    (v) => moveEntries(v.codes, v.folderId), applyMove);
}

// --- folder reorder + bulk remove: invalidate-only (no optimistic path yet) ---
// folder reorder is intentionally NOT optimistic; when folder-DnD lands it may need a
// parallel data.folders path to stay smooth, but that's deferred to a later F-task.
export function useReorderFolders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: string[]) => reorderFolders(orderedIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
export function useRemoveEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (codes: string[]) => removeEntries(codes),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
