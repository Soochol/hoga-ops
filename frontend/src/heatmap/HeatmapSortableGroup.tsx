import type { ReactNode } from 'react';
import { useDndContext, type KeyboardCoordinateGetter } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { GripIcon } from '../ui/RailActionIcons';
import type { HeatmapFolder } from '../api/heatmap';

/** Arrows follow the displayed newspaper reading order, ignoring stock targets. */
export const groupKeyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  const step = ['ArrowDown', 'ArrowRight'].includes(event.code) ? 1
    : ['ArrowUp', 'ArrowLeft'].includes(event.code) ? -1 : 0;
  if (!step || !context.collisionRect || context.active?.data.current?.type !== 'folder') return;
  event.preventDefault();
  const groups = context.droppableContainers.getEnabled().filter(container => container.data.current?.type === 'folder')
    .sort((a, b) => a.data.current?.sortable.index - b.data.current?.sortable.index);
  const index = groups.findIndex(container => container.id === (context.over?.id ?? context.active?.id));
  const target = groups[index + step];
  const rect = target && context.droppableRects.get(target.id);
  if (!rect) return;
  const current = context.collisionRect;
  return {
    x: currentCoordinates.x + rect.left + rect.width / 2 - current.left - current.width / 2,
    y: currentCoordinates.y + rect.top + rect.height / 2 - current.top - current.height / 2,
  };
};

/** Multi-column cards keep their measured positions until drop. Transforming
 * neighbours with a list strategy would preview a different newspaper layout. */
export function HeatmapSortableGroup({ folder, disabledReason, children }: {
  folder: HeatmapFolder;
  disabledReason?: string;
  children: (handle: ReactNode) => ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useSortable({
    id: folder.id,
    data: { type: 'folder', folderId: folder.id, name: folder.name },
    disabled: !!disabledReason,
  });
  const { active, over } = useDndContext();
  const from = active?.data.current?.sortable?.index;
  const to = over?.data.current?.sortable?.index;
  const side = active?.data.current?.type === 'folder' && over?.id === folder.id
    && typeof from === 'number' && typeof to === 'number' && from !== to
    ? (from < to ? 'after' : 'before') : undefined;
  return (
    <div ref={setNodeRef} data-testid={`heatmap-board-group-${folder.id}`}
      className={`relative break-inside-avoid${isDragging ? ' opacity-60' : ''}`}>
      {side && <span data-heatmap-group-drop={side} aria-hidden="true"
        className={`pointer-events-none absolute inset-x-0 z-30 h-0.5 bg-accent ${side === 'before' ? 'top-0' : 'bottom-0'}`} />}
      {children(
        <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners}
          aria-label={`${folder.name} 그룹 순서 이동`}
          aria-disabled={!!disabledReason}
          data-tooltip={disabledReason ?? '그룹 순서 이동 · 드래그 또는 Space 후 방향키, Enter로 놓기 · Escape 취소'}
          className={`flex flex-none items-center justify-center rounded p-1 text-fg-dimmer hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent touch-none ${disabledReason ? 'opacity-40 cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
          onDoubleClick={(event) => event.stopPropagation()}>
          <GripIcon />
        </button>,
      )}
    </div>
  );
}
