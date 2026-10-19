import { useId, useState, type DragEvent } from 'react';
import type { ConditionLeaf } from '../api/screener';
import { ChevronIcon } from '../ui/ChevronIcon';
import { catalogEntry } from './catalog';
import { conditionScope } from './conditionScope';
import './ConditionEditor.css';

export function ConditionRow({
  leaf,
  letter,
  onInsertLetter,
  structureDisabled,
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
  letter?: string;
  onInsertLetter?: () => void;
  structureDisabled?: boolean;
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
  return (
    <div role="group" aria-label={`${entry.label} 조건`} onDragOver={onDragOver} onDrop={onDrop}
      className="screener-condition" data-dragging={dragging || undefined}>
      <div className="condition-header">
        {letter && <button type="button" className="condition-letter font-data"
          aria-label={`${letter} ${entry.label} 조합식에 입력`} disabled={!onInsertLetter}
          onClick={onInsertLetter}>{letter}</button>}
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
          </span>
          <span className="condition-scope">{conditionScope(leaf)}</span>
          <ChevronIcon collapsed={!expanded} />
        </button>
        <button type="button" aria-label="조건 제거" disabled={structureDisabled} onClick={onRemove}
          className="condition-icon-button">×</button>
      </div>
      <div id={editorId} hidden={!expanded}>
        <div className="condition-editor-body">
          <ParamForm params={leaf.params} onChange={(params: ConditionLeaf['params']) => onChange({ ...leaf, params } as ConditionLeaf)} />
        </div>
      </div>
    </div>
  );
}
