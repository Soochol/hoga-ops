import { closestCenter, pointerWithin, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core';

const GROUP_DND_PREFIX = 'study-view-group:';
const ROW_DND_PREFIX = 'study-view-row:';

export type StudyViewTreeDragIntent =
  | { type: 'group'; activeKey: string; overKey: string }
  | { type: 'row'; groupKey: string; activeId: string; overId: string };

export const studyViewTreeCollision: CollisionDetection = (args) => {
  const type = args.active.data.current?.type;
  const p = args.pointerCoordinates;
  const bounds = document.querySelector('[data-testid="saved-views-scroll"]')?.getBoundingClientRect();
  if (p && bounds && (p.x < bounds.left || p.x > bounds.right || p.y < bounds.top || p.y > bounds.bottom)) return [];
  const sameType = args.droppableContainers.filter((container) => container.data.current?.type === type
    && (type !== 'row' || container.data.current?.groupKey === args.active.data.current?.groupKey));
  // Use actual visible bounds so scrolled headers cannot target an unrelated row.
  const droppableRects = new Map(args.droppableRects);
  for (const target of sameType) if (target.node.current) droppableRects.set(target.id, target.node.current.getBoundingClientRect());
  return p ? pointerWithin({ ...args, droppableRects, droppableContainers: sameType }).slice(0, 1)
    : closestCenter({ ...args, droppableContainers: sameType });
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
