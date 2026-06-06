import type { WatchlistFolder, WatchlistEntry } from '../api/watchlist';

export interface FolderGroup {
  /** null = 미분류 (a render-only group; NOT a synthetic folder object — ADR-0004) */
  folder: WatchlistFolder | null;
  entries: WatchlistEntry[];
}

/** UI folder selection: null = 미분류, string = a folder id. */
export type Selected = null | string;

/** The selected folder's entries, sorted by `.order` (null = 미분류, string = folder id).
 *  Shared by the entry pane (what it renders) and the edit modal (the list it
 *  feeds resolveDrag for row indices) so the two stay in lockstep — the
 *  drag-reorder index contract lives in one function, not a comment two files
 *  apart. Pure — no fetch, no synthetic objects. */
export function selectVisibleEntries(
  entries: WatchlistEntry[],
  selected: Selected,
): WatchlistEntry[] {
  const list = entries.filter((e) => e.folder_id === selected);
  return [...list].sort((a, b) => a.order - b.order);
}

/** Group entries by folder for display. Folders sorted by `.order`; 미분류
 *  (folder_id===null) always last. Entries within a group sorted by `.order`.
 *  Empty folders are included. Pure — no fetch, no synthetic objects. */
export function groupByFolder(
  folders: WatchlistFolder[],
  entries: WatchlistEntry[],
): FolderGroup[] {
  const sortedFolders = [...folders].sort((a, b) => a.order - b.order);
  const byOrder = (a: WatchlistEntry, b: WatchlistEntry) => a.order - b.order;
  const groups: FolderGroup[] = sortedFolders.map((folder) => ({
    folder,
    entries: entries.filter((e) => e.folder_id === folder.id).sort(byOrder),
  }));
  groups.push({
    folder: null,
    entries: entries.filter((e) => e.folder_id === null).sort(byOrder),
  });
  return groups;
}

/** 폴더 하나를 한 칸 위/아래로 옮긴 전체 id 순서를 만든다 — 서버 reorder_folders가
 *  전체 id 목록을 요구하는 계약(authoritative ordered_ids)의 클라이언트 절반.
 *  경계 밖(맨 위에서 위로 등)이나 미존재 id면 null. 패널 ⋯ 메뉴와 편집 모달
 *  ▲▼이 공유한다. Pure. */
export function swapFolderOrder(
  folders: WatchlistFolder[],
  folderId: string,
  dir: -1 | 1,
): string[] | null {
  const ids = [...folders].sort((a, b) => a.order - b.order).map((f) => f.id);
  const idx = ids.indexOf(folderId);
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= ids.length) return null;
  [ids[idx], ids[j]] = [ids[j], ids[idx]];
  return ids;
}
