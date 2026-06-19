import { arrayMove } from '@dnd-kit/sortable';

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

/** 다중 소속(v3, ADR-0070): 한 코드가 여러 폴더 행으로 등장 → 한 DndContext 안에서
 *  sortable id 충돌. 폴더 스코프 composite id 로 유일화한다(null=미분류는 heatmap 공유용). */
export function entrySortableId(folderId: string | null, code: string): string {
  return `${folderId ?? UNCAT_SENTINEL}:${code}`;
}
export function parseEntrySortableId(id: string): { folderId: string | null; code: string } {
  const i = id.indexOf(':');
  const f = id.slice(0, i);
  return { folderId: f === UNCAT_SENTINEL ? null : f, code: id.slice(i + 1) };
}

/** activeCode dragged; `over` is either a folder droppable id (see folderDroppableId)
 *  = cross-folder move, or another row code = reorder. */
export function resolveDrag(
  visibleSorted: { code: string }[],   // entries currently shown (one folder), by order
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

export type FolderDragResult = { kind: 'reorder'; orderedIds: string[] } | { kind: 'none' };

/** activeId 폴더를 overId 폴더 위치로 옮긴 전체 id 순서. arrayMove 기반(임의 위치 이동).
 *  기존 swapFolderOrder(grouping.ts)는 ⋯ 메뉴의 한 칸 swap 전용이라 드래그엔 부적합 —
 *  드래그는 임의 거리이므로 resolveDrag(엔트리)와 대칭인 arrayMove 헬퍼를 따로 둔다. */
export function resolveFolderDrag(
  orderedIds: string[],
  activeId: string,
  overId: string,
): FolderDragResult {
  const from = orderedIds.indexOf(activeId);
  const to = orderedIds.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return { kind: 'none' };
  return { kind: 'reorder', orderedIds: arrayMove(orderedIds, from, to) };
}
