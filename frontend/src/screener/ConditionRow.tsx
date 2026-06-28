import type { DragEvent } from 'react';
import type { ConditionLeaf } from '../api/screener';
import { CONDITION_CATALOG } from './catalog';

export function ConditionRow({
  leaf,
  draggable,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onChange,
  onRemove,
}: {
  leaf: ConditionLeaf;
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
  onChange: (next: ConditionLeaf) => void;
  onRemove: () => void;
}) {
  const entry = CONDITION_CATALOG[leaf.type];
  const ParamForm = entry.ParamForm;
  return (
    <div onDragOver={onDragOver} onDrop={onDrop}
      className={`border border-border bg-bg-subtle rounded-md overflow-hidden ${dragging ? 'opacity-60 border-border-strong' : ''}`}>
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button type="button" aria-label="조건 순서 변경" title="조건 순서 변경"
          draggable={draggable}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded text-fg-dimmer hover:text-fg hover:bg-bg-input-hover cursor-grab active:cursor-grabbing disabled:cursor-default"
          disabled={!draggable}>
          ⋮⋮
        </button>
        <span className="text-sm font-medium">{entry.label}</span>
        <span className="font-mono text-xs text-fg-dim">{entry.summarize(leaf.params)}</span>
        <button type="button" aria-label="조건 제거" onClick={onRemove}
          className="ml-auto text-fg-dimmer hover:text-fg bg-transparent border-none cursor-pointer leading-none">×</button>
      </div>
      <div className="px-2.5 pb-2.5">
        <ParamForm params={leaf.params} onChange={(params: ConditionLeaf['params']) => onChange({ ...leaf, params } as ConditionLeaf)} />
      </div>
    </div>
  );
}
