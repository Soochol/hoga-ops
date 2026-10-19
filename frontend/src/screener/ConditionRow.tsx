import { useId, useState, type DragEvent } from 'react';
import type { ConditionLeaf } from '../api/screener';
import { ChevronIcon } from '../ui/ChevronIcon';
import { catalogEntry } from './catalog';
import { conditionDescription, conditionScope } from './conditionDescription';
import './ConditionEditor.css';

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
  const entry = catalogEntry(leaf.type);
  const ParamForm = entry.ParamForm;
  const [expanded, setExpanded] = useState(true);
  const editorId = useId();
  const summary = conditionDescription(leaf);
  return (
    <div role="group" aria-label={`${entry.label} 조건`} onDragOver={onDragOver} onDrop={onDrop}
      className="screener-condition" data-dragging={dragging || undefined}>
      <div className="condition-header">
        <button type="button" aria-label="조건 순서 변경" title="조건 순서 변경"
          draggable={draggable}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="condition-icon-button condition-drag-handle"
          disabled={!draggable}>
          ⋮⋮
        </button>
        <button type="button" className="condition-toggle" aria-expanded={expanded}
          aria-controls={editorId} aria-label={`${entry.label} ${expanded ? '접기' : '펼치기'}`}
          onClick={() => setExpanded(value => !value)}>
          <span className="condition-heading">
            <span className="condition-name">{entry.label}</span>
            {!expanded && <span className="condition-collapsed-summary font-data">{summary}</span>}
          </span>
          {expanded && <span className="condition-scope">{conditionScope(leaf)}</span>}
          <ChevronIcon collapsed={!expanded} />
        </button>
        <button type="button" aria-label="조건 제거" onClick={onRemove}
          className="condition-icon-button">×</button>
      </div>
      <div id={editorId} hidden={!expanded}>
        <div className="condition-editor-body">
          <ParamForm params={leaf.params} onChange={(params: ConditionLeaf['params']) => onChange({ ...leaf, params } as ConditionLeaf)} />
        </div>
        <p className="condition-summary" aria-live="polite">{summary}</p>
      </div>
    </div>
  );
}
