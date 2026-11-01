import { AppIcon } from '../ui/AppIcon';
import { useState, type ReactNode, type DragEvent } from 'react';
import type { CalculationPolicy, ConditionLeaf, ConditionType, ScreenerUniverse } from '../api/screener';
import { catalogEntry } from './catalog';
import { UniverseFilterButton } from './UniverseFilterButton';
import { ConditionSettingsDialog, type ConditionEditorMode } from './ConditionSettingsDialog';
import { conditionLabel, defaultExpression, expressionError } from './conditionExpression';
import './ConditionEditor.css';

export function ConditionBuilder({ conditions, universe, onConditionsChange, onUniverseChange, expression, onExpressionChange,
  expressionScope, children, calculationPolicy }: {
  calculationPolicy?: CalculationPolicy; children?: ReactNode; expression?: string | null;
  onExpressionChange?: (value: string) => void; expressionScope?: string | null;
  conditions: ConditionLeaf[]; universe: ScreenerUniverse;
  onConditionsChange: (c: ConditionLeaf[]) => void; onUniverseChange: (u: ScreenerUniverse) => void;
}) {
  const [editor, setEditor] = useState<{ mode: ConditionEditorMode; id?: string; open: boolean } | null>(null);
  const [catalogType, setCatalogType] = useState<ConditionType>('price_range');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const error = expressionError(expression, conditions.length);
  const openMine = (id?: string) => setEditor({ mode: 'mine', id, open: true });
  const remove = (id: string) => { if (!error) onConditionsChange(conditions.filter(c => c.id !== id)); };
  const moveTo = (targetId: string) => {
    if (error || !draggingId || draggingId === targetId) return;
    const from = conditions.findIndex(c => c.id === draggingId), to = conditions.findIndex(c => c.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...conditions], [moved] = next.splice(from, 1);
    next.splice(to, 0, moved); onConditionsChange(next); setDraggingId(null);
  };
  const handleDragStart = (id: string, event: DragEvent<HTMLButtonElement>) => {
    setDraggingId(id); event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  };
  return <div className="flex h-full flex-col gap-sm min-h-0 overflow-auto p-md">
    <div className="flex gap-sm items-stretch">
      <button type="button" aria-label="조건 추가" aria-haspopup="dialog" aria-expanded={!!editor?.open && editor.mode === 'catalog'}
        onClick={() => setEditor({ mode: 'catalog', open: true })}
        className="flex-1 border border-dashed border-border-strong rounded-md text-fg-dim text-sm py-2 hover:bg-bg-input-hover">
        <AppIcon name="plus" /> 조건 추가
      </button>
      <UniverseFilterButton universe={universe} onChange={onUniverseChange} />
    </div>
    {conditions.length > 0 && onExpressionChange && <>
      <button type="button" aria-label="조건 조합 편집" aria-haspopup="dialog" className="condition-expression-summary" onClick={() => openMine()}>
        <span>조건 조합</span><code className="font-data">{expression ?? defaultExpression(conditions.length)}</code>
      </button>
      {error && !editor?.open && <p role="alert" className="condition-expression-error">{error}</p>}
    </>}
    {conditions.map((leaf, i) => <div key={leaf.id} className="screener-condition condition-summary-card"
      data-dragging={draggingId === leaf.id || undefined}
      onDragOver={event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }}
      onDrop={() => moveTo(leaf.id)}>
      <button type="button" className="condition-icon-button condition-drag-handle" aria-label="조건 순서 변경"
        disabled={!!error || conditions.length < 2} draggable={!error && conditions.length > 1}
        onDragStart={event => handleDragStart(leaf.id, event)} onDragEnd={() => setDraggingId(null)}>⋮⋮</button>
      <span className="condition-letter font-data">{conditionLabel(i)}</span>
      <button type="button" className="condition-summary-open" aria-label={`${conditionLabel(i)} ${catalogEntry(leaf.type).label} 설정`}
        aria-haspopup="dialog" onClick={() => openMine(leaf.id)}>
        <span className="condition-name">{catalogEntry(leaf.type).label}</span>
        <span>{catalogEntry(leaf.type).summarize(leaf.params)}</span>
      </button>
      <button type="button" className="condition-icon-button" aria-label={`${conditionLabel(i)} 조건 제거`} disabled={!!error}
        onClick={() => remove(leaf.id)}><AppIcon name="close" /></button>
    </div>)}
    {children}
    {editor && <ConditionSettingsDialog open={editor.open} conditions={conditions} calculationPolicy={calculationPolicy}
      expression={expression} expressionScope={expressionScope} initialMode={editor.mode} initialId={editor.id} initialType={catalogType}
      onConditionsChange={onConditionsChange} onExpressionChange={onExpressionChange}
      onCatalogSelect={setCatalogType} onClose={() => setEditor(previous => previous && { ...previous, open: false })} />}
  </div>;
}
