import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { WATCHLIST_KEY } from './watchlistKeys';
import {
  getWatchlist,
  addMember,
  removeMember,
  removeFromWatchlist,
  catchupNow,
  catchupAll,
  createFolder,
  renameFolder,
  deleteFolder,
  reorderFolders,
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

// --- membership / reorder: optimistic + rollback (DnD smoothness) ---
type ReorderVars = { folderId: string; orderedCodes: string[] };
type AddMemberVars = { folderId: string; code: string; name: string };
type RemoveMemberVars = { folderId: string; code: string };

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
// v3 멤버십(펼친 와이어): 한 코드가 N폴더면 N행. add=대상 폴더에 행 1개 추가(다른 폴더
// 행 보존), remove=그 폴더 행만 제거. 백엔드가 entry 생성/삭제·order compact를 확정한다.
function applyAddMember(data: WatchlistResponse, v: AddMemberVars): WatchlistResponse {
  if (data.entries.some((e) => e.folder_id === v.folderId && e.code === v.code)) return data;
  const base = Math.max(-1, ...data.entries.filter((e) => e.folder_id === v.folderId).map((e) => e.order)) + 1;
  const existing = data.entries.find((e) => e.code === v.code);
  const row: WatchlistResponse['entries'][number] = {
    code: v.code,
    name: existing?.name ?? v.name,
    registered_at_kst_date: existing?.registered_at_kst_date ?? '',
    last_success_date: existing?.last_success_date ?? null,
    folder_id: v.folderId,
    order: base,
  };
  return { ...data, entries: [...data.entries, row] };
}
function applyRemoveMember(data: WatchlistResponse, v: RemoveMemberVars): WatchlistResponse {
  return {
    ...data,
    entries: data.entries.filter((e) => !(e.folder_id === v.folderId && e.code === v.code)),
  };
}
function applyFolderReorder(data: WatchlistResponse, orderedIds: string[]): WatchlistResponse {
  const rank = new Map(orderedIds.map((id, i) => [id, i] as const));
  return {
    ...data,
    folders: data.folders.map((f) => (rank.has(f.id) ? { ...f, order: rank.get(f.id)! } : f)),
  };
}

function useOptimisticWatchlistMutation<V>(
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
  return useOptimisticWatchlistMutation<ReorderVars>(
    (v) => reorderEntries(v.folderId, v.orderedCodes), applyReorder);
}
export function useAddMember() {
  return useOptimisticWatchlistMutation<AddMemberVars>(
    (v) => addMember(v.folderId, v.code).then(() => undefined), applyAddMember);
}
export function useRemoveMember() {
  return useOptimisticWatchlistMutation<RemoveMemberVars>(
    (v) => removeMember(v.folderId, v.code), applyRemoveMember);
}

// --- folder reorder + bulk remove ---
// folder reorder: optimistic + rollback (folder-DnD 부드러움). 엔트리와 같은 제네릭 경로.
export function useReorderFolders() {
  return useOptimisticWatchlistMutation<string[]>(
    (orderedIds) => reorderFolders(orderedIds), applyFolderReorder);
}
export function useRemoveEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (codes: string[]) => removeEntries(codes),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
