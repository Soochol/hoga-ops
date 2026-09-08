import type { WatchlistResponse, WatchlistItemRef, WatchlistFolderItemsChange } from '../api/watchlist';
import { mergePanelRows, toItemRefs } from './panelRows';

export interface TransferSource { folderId: string; code: string }
export const itemKey = (i: WatchlistItemRef) => i.kind === 'code' ? i.code : i.id;
export function folderItems(data: WatchlistResponse, folderId: string): WatchlistItemRef[] {
  return toItemRefs(mergePanelRows(data.entries.filter((e) => e.folder_id === folderId), data.memos.filter((m) => m.folder_id === folderId)));
}
/** at is a gap in the original target list, including memo rows. Duplicates merge. */
export function planTransfer(data: WatchlistResponse, sources: TransferSource[], target: string, at: number, preserveTargetOrder = false): WatchlistFolderItemsChange[] {
  if (!data.folders.some((f) => f.id === target)) return [];
  const valid = sources.filter((s) => data.entries.some((e) => e.folder_id === s.folderId && e.code === s.code));
  const codes = [...new Set(valid.map((s) => s.code))];
  if (!codes.length) return [];
  const moved = new Set(codes);
  const ids = [...new Set([...valid.map((s) => s.folderId), target])];
  const changes = ids.map((folder_id) => {
    const before = folderItems(data, folder_id);
    let after: WatchlistItemRef[];
    if (folder_id === target) {
      if (preserveTargetOrder) {
        const existing = new Set(before.filter((i) => i.kind === 'code').map((i) => i.code));
        after = [...before, ...codes.filter((c) => !existing.has(c)).map(code => ({ kind: 'code' as const, code }))];
        return { folder_id, before, after };
      }
      const keep = (i: WatchlistItemRef) => i.kind !== 'code' || !moved.has(i.code);
      const index = before.slice(0, Math.max(0, at)).filter(keep).length;
      after = before.filter(keep);
      after.splice(index, 0, ...codes.map((code): WatchlistItemRef => ({ kind: 'code', code })));
    } else {
      const removed = new Set(valid.filter((s) => s.folderId === folder_id).map((s) => s.code));
      after = before.filter((i) => i.kind !== 'code' || !removed.has(i.code));
    }
    return { folder_id, before, after };
  });
  return changes.some((c) => JSON.stringify(c.before) !== JSON.stringify(c.after)) ? changes : [];
}
export function inverseTransfer(changes: WatchlistFolderItemsChange[]): WatchlistFolderItemsChange[] {
  return changes.map((c) => ({ folder_id: c.folder_id, before: c.after, after: c.before }));
}
export function applyTransfer(data: WatchlistResponse, changes: WatchlistFolderItemsChange[]): WatchlistResponse {
  const affected = new Set(changes.map((c) => c.folder_id));
  const entries = data.entries.filter((e) => !affected.has(e.folder_id ?? ''));
  const memos = data.memos.filter((m) => !affected.has(m.folder_id));
  for (const c of changes) c.after.forEach((i, order) => {
    if (i.kind === 'code') {
      const e = data.entries.find((e) => e.code === i.code);
      if (e) entries.push({ ...e, folder_id: c.folder_id, order });
    } else {
      const m = data.memos.find((m) => m.id === i.id);
      if (m) memos.push({ ...m, folder_id: c.folder_id, order });
    }
  });
  return { ...data, entries, memos };
}
