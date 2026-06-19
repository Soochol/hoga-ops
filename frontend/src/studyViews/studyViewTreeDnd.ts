import { closestCenter, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core';

const GROUP_DND_PREFIX = 'study-view-group:';
const ROW_DND_PREFIX = 'study-view-row:';

export type StudyViewTreeDragIntent =
  | { type: 'group'; activeKey: string; overKey: string }
  | { type: 'row'; groupKey: string; activeId: string; overId: string };

export const studyViewTreeCollision: CollisionDetection = (args) => {
  const type = args.active.data.current?.type;
  const sameType = args.droppableContainers.filter((container) => container.data.current?.type === type);
  return closestCenter({ ...args, droppableContainers: sameType });
};

export function studyViewGroupDndId(key: string): string {
  return `${GROUP_DND_PREFIX}${key}`;
}

export function studyViewRowDndId(id: string): string {
  return `${ROW_DND_PREFIX}${id}`;
}

function parseGroupDndId(id: string): string | null {
  return id.startsWith(GROUP_DND_PREFIX) ? id.slice(GROUP_DND_PREFIX.length) : null;
}

function parseRowDndId(id: string): string | null {
  return id.startsWith(ROW_DND_PREFIX) ? id.slice(ROW_DND_PREFIX.length) : null;
}

export function resolveStudyViewTreeDrag(event: DragEndEvent): StudyViewTreeDragIntent | null {
  const { active, over } = event;
  if (!over || active.id === over.id) return null;

  if (active.data.current?.type === 'group') {
    const activeKey = parseGroupDndId(String(active.id));
    const overKey = parseGroupDndId(String(over.id));
    return activeKey && overKey ? { type: 'group', activeKey, overKey } : null;
  }

  if (active.data.current?.type === 'row') {
    const activeId = parseRowDndId(String(active.id));
    const overId = parseRowDndId(String(over.id));
    const activeGroup = active.data.current.groupKey;
    const overGroup = over.data.current?.groupKey;
    if (activeId && overId && typeof activeGroup === 'string' && activeGroup === overGroup) {
      return { type: 'row', groupKey: activeGroup, activeId, overId };
    }
  }

  return null;
}
