import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { HEATMAP_KEY } from './heatmapKeys';
import { INDEX_SECTOR_RANKINGS_KEY } from '../api/indexSectorRankings';
import {
  getHeatmap,
  addToHeatmapFolder,
  removeFromHeatmap,
  createHeatmapFolder,
  renameHeatmapFolder,
  deleteHeatmapFolder,
  reorderHeatmapFolders,
  moveHeatmapEntries,
  reorderHeatmapEntries,
  removeHeatmapEntries,
  type HeatmapResponse,
} from '../api/heatmap';

// Cloned from watchlist/useWatchlist.ts (ADR-0068 G2): the heatmap is an
// independent store, so every hook here invalidates HEATMAP_KEY ONLY — adding
// to the heatmap never touches ['watchlist'] and vice versa. The capture-only
// hooks (useCatchupOne/All) are intentionally absent (heatmap drives no captures).

export function useHeatmap() {
  return useQuery<HeatmapResponse>({
    queryKey: HEATMAP_KEY,
    queryFn: getHeatmap,
  });
}

function invalidateHeatmapDependents(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: HEATMAP_KEY });
  void qc.invalidateQueries({ queryKey: INDEX_SECTOR_RANKINGS_KEY });
}

export function useAddToHeatmapFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['heatmap', 'add-to-folder'],
    mutationFn: (v: { code: string; folderId: string }) => addToHeatmapFolder(v.code, v.folderId),
    onSuccess: () => invalidateHeatmapDependents(qc),
  });
}

export function useRemoveFromHeatmap() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['heatmap', 'remove'],
    mutationFn: (code: string) => removeFromHeatmap(code),
    onSuccess: () => invalidateHeatmapDependents(qc),
  });
}

// --- folder CRUD: invalidate-only (consistent with add/remove) ---
export function useCreateHeatmapFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createHeatmapFolder(name),
    onSuccess: () => invalidateHeatmapDependents(qc),
  });
}
export function useRenameHeatmapFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { folderId: string; name: string }) => renameHeatmapFolder(v.folderId, v.name),
    onSuccess: () => invalidateHeatmapDependents(qc),
  });
}
export function useDeleteHeatmapFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (folderId: string) => deleteHeatmapFolder(folderId),
    onSuccess: () => invalidateHeatmapDependents(qc),
  });
}

// --- move / reorder: optimistic + rollback (DnD smoothness) ---
type ReorderVars = { folderId: string; orderedCodes: string[] };
type MoveVars = { codes: string[]; folderId: string };

// no-jump invariant: 서버가 target 그룹을 0..N-1로 compact 유지하므로(_reindex), 아래 낙관적
// order는 invalidate 후 서버 값과 같은 *상대순서*에 안착 → 화면 jump 없음 (useWatchlist 와 동일).
function applyReorder(data: HeatmapResponse, v: ReorderVars): HeatmapResponse {
  const rank = new Map(v.orderedCodes.map((c, i) => [c, i] as const));
  return {
    ...data,
    entries: data.entries.map((e) =>
      e.folder_id === v.folderId && rank.has(e.code)
        ? { ...e, order: rank.get(e.code)! } : e),
  };
}
function applyMove(data: HeatmapResponse, v: MoveVars): HeatmapResponse {
  const base = Math.max(-1, ...data.entries.filter((e) => e.folder_id === v.folderId).map((e) => e.order)) + 1;
  const set = new Set(v.codes);
  return {
    ...data,
    entries: data.entries.map((e) =>
      set.has(e.code) ? { ...e, folder_id: v.folderId, order: base + v.codes.indexOf(e.code) } : e),
  };
}
function applyFolderReorder(data: HeatmapResponse, orderedIds: string[]): HeatmapResponse {
  const rank = new Map(orderedIds.map((id, i) => [id, i] as const));
  return {
    ...data,
    folders: data.folders.map((f) => (rank.has(f.id) ? { ...f, order: rank.get(f.id)! } : f)),
  };
}

function useOptimisticHeatmapMutation<V>(
  mutationFn: (v: V) => Promise<void>,
  apply: (d: HeatmapResponse, v: V) => HeatmapResponse,
) {
  const qc = useQueryClient();
  return useMutation<void, Error, V, { prev?: HeatmapResponse }>({
    mutationFn,
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: HEATMAP_KEY });
      const prev = qc.getQueryData<HeatmapResponse>(HEATMAP_KEY);
      if (prev) qc.setQueryData(HEATMAP_KEY, apply(prev, v));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(HEATMAP_KEY, ctx.prev); },
    onSettled: () => invalidateHeatmapDependents(qc),
  });
}

export function useReorderHeatmapEntries() {
  return useOptimisticHeatmapMutation<ReorderVars>(
    (v) => reorderHeatmapEntries(v.folderId, v.orderedCodes), applyReorder);
}
export function useMoveHeatmapEntries() {
  return useOptimisticHeatmapMutation<MoveVars>(
    (v) => moveHeatmapEntries(v.codes, v.folderId), applyMove);
}
export function useReorderHeatmapFolders() {
  return useOptimisticHeatmapMutation<string[]>(
    (orderedIds) => reorderHeatmapFolders(orderedIds), applyFolderReorder);
}
export function useRemoveHeatmapEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (codes: string[]) => removeHeatmapEntries(codes),
    onSuccess: () => invalidateHeatmapDependents(qc),
  });
}
