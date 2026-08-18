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
  setFolderCaptureEnabled,
  deleteFolder,
  reorderFolders,
  reorderEntries,
  reorderItems,
  removeEntries,
  addMemo,
  updateMemo,
  removeMemo,
  type WatchlistResponse,
  type WatchlistItemRef,
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
type ItemsReorderVars = { folderId: string; orderedItems: WatchlistItemRef[] };
type AddMemberVars = { folderId: string; code: string; name: string; at?: number };
type RemoveMemberVars = { folderId: string; code: string };
type CaptureVars = { folderId: string; captureEnabled: boolean };

// no-jump invariant: 서버가 target 그룹을 0..N-1로 compact 유지하므로(_reindex), 아래 낙관적
// order는 invalidate 후 서버 값과 같은 *상대순서*에 안착 → 화면 jump 없음. 렌더는 .order로
// 정렬하므로 절대값 차이는 무해. (이 불변식이 깨지면 낙관적 업데이트가 깜빡일 수 있으니 유지.)
//
// v4 주의: order 축은 폴더 items 인덱스라 **entries 와 memos 가 한 축을 공유**한다.
// 코드에만 rank 를 다시 매기면 메모의 order 가 옛 값에 남아 두 축이 어긋나고, 병합
// 정렬에서 행이 겹치거나 자리를 바꾼다. 아래 두 함수가 그래서 memos 를 함께 본다.
function applyReorder(data: WatchlistResponse, v: ReorderVars): WatchlistResponse {
  // 편집 모달 경로(ordered_codes): 코드만 재배열하고 메모는 items 인덱스에 고정 —
  // 서버 reorder_entries 와 같은 시맨틱이라 코드가 차지하던 order 슬롯을 그대로 쓴다.
  const slots = data.entries
    .filter((e) => e.folder_id === v.folderId)
    .map((e) => e.order)
    .sort((a, b) => a - b);
  const slotOf = new Map(v.orderedCodes.map((c, i) => [c, slots[i]] as const));
  return {
    ...data,
    entries: data.entries.map((e) =>
      e.folder_id === v.folderId && slotOf.has(e.code)
        ? { ...e, order: slotOf.get(e.code)! } : e),
  };
}

/** 패널 dnd 경로(ordered_items): 표시 순서 전체를 다시 매긴다 — **entries 와 memos
 *  양쪽**을 같은 rank 맵으로 갱신해야 서버(items 인덱스)와 값이 일치한다. */
function applyItemsReorder(data: WatchlistResponse, v: ItemsReorderVars): WatchlistResponse {
  const rank = new Map(v.orderedItems.map((it, i) =>
    [it.kind === 'code' ? `c:${it.code}` : `m:${it.id}`, i] as const));
  return {
    ...data,
    entries: data.entries.map((e) =>
      e.folder_id === v.folderId && rank.has(`c:${e.code}`)
        ? { ...e, order: rank.get(`c:${e.code}`)! } : e),
    memos: data.memos.map((m) =>
      m.folder_id === v.folderId && rank.has(`m:${m.id}`)
        ? { ...m, order: rank.get(`m:${m.id}`)! } : m),
  };
}
// v3 멤버십(펼친 와이어): 한 코드가 N폴더면 N행. add=대상 폴더에 행 1개 추가(다른 폴더
// 행 보존), remove=그 폴더 행만 제거. 백엔드가 entry 생성/삭제·order compact를 확정한다.
function applyAddMember(data: WatchlistResponse, v: AddMemberVars): WatchlistResponse {
  // 이미 멤버면 no-op — 서버 add 도 멱등이라 `at` 이 와도 자리를 옮기지 않는다.
  // 낙관 쪽만 옮기면 invalidate 후 되돌아가는 "튀는" 행이 된다.
  if (data.entries.some((e) => e.folder_id === v.folderId && e.code === v.code)) return data;
  // v4: max 를 entries 만으로 구하면 **폴더 끝이 메모일 때 어긋난다** — items 가
  // [codeA(0), memo(1)] 이면 서버는 새 코드에 order 2 를 주는데 entries-only max 는
  // 1 을 만들어 메모와 충돌한다. 두 배열을 함께 본다(같은 축이므로).
  const end = Math.max(
    -1,
    ...data.entries.filter((e) => e.folder_id === v.folderId).map((e) => e.order),
    ...data.memos.filter((m) => m.folder_id === v.folderId).map((m) => m.order),
  ) + 1;
  // `at` 미지정 = 맨 뒤(기존 경로). 상한 클램프는 서버가 하고 여기선 안 한다 —
  // order 는 정렬 키라 end 보다 큰 값도 "맨 뒤" 로 같은 자리에 그린다.
  const at = v.at ?? end;
  const existing = data.entries.find((e) => e.code === v.code);
  const row: WatchlistResponse['entries'][number] = {
    code: v.code,
    name: existing?.name ?? v.name,
    registered_at_kst_date: existing?.registered_at_kst_date ?? '',
    last_success_date: existing?.last_success_date ?? null,
    folder_id: v.folderId,
    order: at,
  };
  // 삽입 자리 뒤를 한 칸씩 민다 — **entries 와 memos 양쪽 다**. 한쪽만 밀면 두
  // 배열이 같은 order 를 갖게 되고 mergePanelRows 의 정렬에서 행이 겹친다(그 축이
  // 하나라는 게 v4 의 전제다). at===end 면 대상이 없어 기존 append 와 동일하다.
  const pushDown = <T extends { folder_id: string | null; order: number }>(rows: T[]): T[] =>
    rows.map((r) => (r.folder_id === v.folderId && r.order >= at ? { ...r, order: r.order + 1 } : r));
  return {
    ...data,
    entries: [...pushDown(data.entries), row],
    memos: pushDown(data.memos),
  };
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
function applyFolderCapture(data: WatchlistResponse, v: CaptureVars): WatchlistResponse {
  return {
    ...data,
    folders: data.folders.map((f) =>
      f.id === v.folderId ? { ...f, capture_enabled: v.captureEnabled } : f),
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
export function useReorderItems() {
  return useOptimisticWatchlistMutation<ItemsReorderVars>(
    (v) => reorderItems(v.folderId, v.orderedItems), applyItemsReorder);
}
export function useAddMember() {
  return useOptimisticWatchlistMutation<AddMemberVars>(
    (v) => addMember(v.folderId, v.code, v.at).then(() => undefined), applyAddMember);
}
export function useRemoveMember() {
  return useOptimisticWatchlistMutation<RemoveMemberVars>(
    (v) => removeMember(v.folderId, v.code), applyRemoveMember);
}
export function useSetFolderCaptureEnabled() {
  return useOptimisticWatchlistMutation<CaptureVars>(
    (v) => setFolderCaptureEnabled(v.folderId, v.captureEnabled).then(() => undefined),
    applyFolderCapture,
  );
}

/** v3: 코드를 from→to 폴더로 이동 = 대상 폴더에 추가 후 출처 폴더에서 제거(둘 다 멤버십).
 *  "이동"은 단일 소속 idiom의 잔재이지만 편집모달 드래그·다중선택 이동 UX를 보존한다. */
export function useMoveMember() {
  const add = useAddMember();
  const remove = useRemoveMember();
  return async ({ code, from, to, name = '' }:
    { code: string; from: string; to: string; name?: string }) => {
    if (from === to) return;
    await add.mutateAsync({ folderId: to, code, name });
    await remove.mutateAsync({ folderId: from, code });
  };
}

// --- folder reorder + bulk remove ---
// folder reorder: optimistic + rollback (folder-DnD 부드러움). 엔트리와 같은 제네릭 경로.
export function useReorderFolders() {
  return useOptimisticWatchlistMutation<string[]>(
    (orderedIds) => reorderFolders(orderedIds), applyFolderReorder);
}
// --- 메모("빈칸") CRUD: invalidate-only (폴더 CRUD 선례) ---
// 드래그처럼 연속 조작이 아니라 낙관 경로의 이득이 작다. 인라인 편집 저장 시 한
// 프레임 깜빡임이 거슬리면 그때 승격한다.
export function useAddMemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { folderId: string; text?: string; at?: number }) =>
      addMemo(v.folderId, v.text ?? '', v.at),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
export function useUpdateMemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { memoId: string; text: string }) => updateMemo(v.memoId, v.text),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
export function useRemoveMemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memoId: string) => removeMemo(memoId),
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
