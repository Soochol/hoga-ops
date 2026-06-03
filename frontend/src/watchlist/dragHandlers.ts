import { arrayMove } from '@dnd-kit/sortable';
import type { WatchlistEntry } from '../api/watchlist';

export type DragResult =
  | { kind: 'reorder'; folderId: string | null; orderedCodes: string[] }
  | { kind: 'move'; codes: string[]; folderId: string | null }
  | { kind: 'none' };

// Single source of the folder drop-target id codec — encode (folderDroppableId)
// and decode (resolveDrag) live here so the prefix + null-sentinel can't drift
// between WatchlistEditModal's useDroppable calls and resolveDrag.
const FOLDER_DROP_PREFIX = 'folder:';
const UNCAT_SENTINEL = '__uncat__';

/** Encode a folder as a dnd-kit droppable id. null (미분류) → "folder:__uncat__". */
export function folderDroppableId(folderId: string | null): string {
  return FOLDER_DROP_PREFIX + (folderId ?? UNCAT_SENTINEL);
}

/** activeCode dragged; `over` is either a folder droppable id (see folderDroppableId)
 *  = cross-folder move, or another row code = reorder. */
export function resolveDrag(
  visibleSorted: WatchlistEntry[],   // entries currently shown (one folder), by order
  selectedFolder: string | null,
  activeCode: string,
  overId: string,
): DragResult {
  if (overId.startsWith(FOLDER_DROP_PREFIX)) {
    const raw = overId.slice(FOLDER_DROP_PREFIX.length);
    const folderId = raw === UNCAT_SENTINEL ? null : raw;
    if (folderId === selectedFolder) return { kind: 'none' };
    return { kind: 'move', codes: [activeCode], folderId };
  }
  const from = visibleSorted.findIndex((e) => e.code === activeCode);
  const to = visibleSorted.findIndex((e) => e.code === overId);
  if (from < 0 || to < 0 || from === to) return { kind: 'none' };
  const orderedCodes = arrayMove(visibleSorted, from, to).map((e) => e.code);
  return { kind: 'reorder', folderId: selectedFolder, orderedCodes };
}
