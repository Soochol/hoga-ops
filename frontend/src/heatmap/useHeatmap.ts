import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { HEATMAP_KEY, invalidateHeatmapDependents } from './heatmapKeys';
import {
  getHeatmap,
  addToHeatmapFolder,
  removeFromHeatmap,
  removeFromHeatmapFolder,
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

export function useAddToHeatmapFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['heatmap', 'add-to-folder'],
    mutationFn: (v: { code: string; folderId: string }) => addToHeatmapFolder(v.code, v.folderId),
    onSuccess: () => invalidateHeatmapDependents(qc),
  });
}

/** 그룹 스코프 해제 — folderId 를 준 그룹에서만 뺀다(다른 그룹 등록은 유지).
 *  folderId 미전달이면 모든 그룹에서 제거. 한 종목이 여러 그룹에 등록될 수 있으므로
 *  화면의 특정 행을 지우는 호출자는 반드시 그 행의 folder_id 를 넘겨야 한다. */
export function useRemoveFromHeatmap() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['heatmap', 'remove'],
    mutationFn: (v: { code: string; folderId?: string }) =>
      (v.folderId === undefined
        ? removeFromHeatmap(v.code)
        : removeFromHeatmapFolder(v.code, v.folderId)),
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
/** fromFolderId = 끌어낸 원본 그룹. 한 종목이 여러 그룹에 등록될 수 있어 code 만으로는
 *  어느 등록을 옮길지 결정되지 않는다(서버도 같은 이유로 from_folder_id 를 요구). */
type MoveVars = { codes: string[]; fromFolderId: string; folderId: string };

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
  if (v.fromFolderId === v.folderId) return data;
  const base = Math.max(-1, ...data.entries.filter((e) => e.folder_id === v.folderId).map((e) => e.order)) + 1;
  const set = new Set(v.codes);
  // 도착 그룹에 이미 있는 코드는 **이동이 아니라 소멸**이다 — 한 그룹은 같은 코드를 한 번만
  // 담으므로 서버가 원본 등록을 지운다. 낙관적 갱신도 같게 접어야 invalidate 직후 행이
  // 사라지며 깜빡이지 않는다.
  const already = new Set(
    data.entries.filter((e) => e.folder_id === v.folderId).map((e) => e.code));
  const moving = v.codes.filter((c) => !already.has(c));
  const targeted = (e: HeatmapResponse['entries'][number]) =>
    e.folder_id === v.fromFolderId && set.has(e.code);
  return {
    ...data,
    entries: data.entries
      .filter((e) => !(targeted(e) && already.has(e.code)))
      .map((e) =>
        targeted(e) ? { ...e, folder_id: v.folderId, order: base + moving.indexOf(e.code) } : e),
  };
}
/** Ctrl+드래그 복제 = 원본 등록을 남긴 채 대상 그룹에 **추가**. 서버 커맨드는 일반 추가
 *  (addToHeatmapFolder)와 같다 — 다중 그룹 등록이 허용된 뒤로 "추가"가 곧 복제다. */
type CopyVars = { code: string; name: string; folderId: string };
function applyCopy(data: HeatmapResponse, v: CopyVars): HeatmapResponse {
  // 대상 그룹에 이미 있으면 서버는 멱등(이름만 갱신) — 낙관적으로 행을 하나 더 넣으면
  // 한 그룹에 같은 code 두 행이 되어 React key 가 충돌하고 invalidate 후 사라진다.
  if (data.entries.some((e) => e.folder_id === v.folderId && e.code === v.code)) return data;
  const base = Math.max(-1, ...data.entries.filter((e) => e.folder_id === v.folderId).map((e) => e.order)) + 1;
  return {
    ...data,
    entries: [...data.entries, { code: v.code, name: v.name, folder_id: v.folderId, order: base }],
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
    (v) => moveHeatmapEntries(v.codes, v.fromFolderId, v.folderId), applyMove);
}
/** 그룹 간 Ctrl+드래그 복제. move 와 같은 낙관적 하네스를 쓴다 — 드래그 커밋 직후 대상
 *  그룹에 행이 바로 나타나야 "복제됐다"가 손끝에서 확인된다(invalidate 왕복을 기다리면
 *  드롭과 반영 사이에 빈 구간이 생긴다). */
export function useCopyHeatmapEntry() {
  return useOptimisticHeatmapMutation<CopyVars>(
    (v) => addToHeatmapFolder(v.code, v.folderId).then(() => undefined), applyCopy);
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
