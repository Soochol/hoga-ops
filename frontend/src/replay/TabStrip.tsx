import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTabsStore, TABS_SOFT_CAP } from '../state/tabs';
import Tab from './Tab';
import type { Tab as TabModel } from '../state/tabs';

export default function TabStrip() {
  const { tabs, activeTabId, setActive, closeTab, newTab } = useTabsStore();
  const tabCount = useTabsStore((s) => s.tabs.length);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = tabs.findIndex((t) => t.id === active.id);
    const to = tabs.findIndex((t) => t.id === over.id);
    if (from < 0 || to < 0) return;
    useTabsStore.setState({ tabs: arrayMove(tabs, from, to) });
  };

  return (
    <div className="flex items-end gap-px px-3.5 bg-bg-subtle border-b h-10">
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          {tabs.map((t) => (
            <SortableTab
              key={t.id}
              tab={t}
              isActive={t.id === activeTabId}
              isLast={tabs.length === 1}
              onActivate={() => setActive(t.id)}
              onClose={() => closeTab(t.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <button
        onClick={() => newTab()}
        className="h-[30px] px-3 mb-px ml-1.5 border border-dashed border-border-strong rounded text-fg-dim hover:text-fg hover:border-accent text-xs font-medium"
      >
        + 새 분석
      </button>
      <span className="flex-1" />
      <span className="font-mono text-[10.5px] text-fg-dimmer pb-2">
        {tabCount} / {TABS_SOFT_CAP} open
      </span>
    </div>
  );
}

function SortableTab(props: {
  tab: TabModel;
  isActive: boolean;
  isLast: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: props.tab.id });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <Tab {...props} />
    </div>
  );
}
