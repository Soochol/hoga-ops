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
