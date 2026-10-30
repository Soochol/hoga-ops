import { ChevronIcon } from '../ui/ChevronIcon';
import { AppIcon } from '../ui/AppIcon';
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type DragEvent } from 'react';
import type { CalculationPolicy, ConditionLeaf, ConditionType, ScreenerUniverse } from '../api/screener';
import { CONDITION_CATALOG, makeLeaf } from './catalog';
import { ConditionRow } from './ConditionRow';
import { UniverseFilterButton } from './UniverseFilterButton';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { CONDITION_GROUPS } from './ConditionBuilderHelpers';
import { ConditionExpressionEditor } from './ConditionExpressionEditor';
import { conditionLabel, defaultExpression, expressionError, MAX_EXPRESSION_LENGTH } from './conditionExpression';
import { useExpressionUndo } from './useExpressionUndo';


export function ConditionBuilder({ conditions, universe, onConditionsChange, onUniverseChange, expression, onExpressionChange,
  expressionScope, children, calculationPolicy }: {
  calculationPolicy?: CalculationPolicy;
  children?: ReactNode;
  expression?: string | null;
  onExpressionChange?: (value: string) => void;
  expressionScope?: string | null;
  conditions: ConditionLeaf[]; universe: ScreenerUniverse;
  onConditionsChange: (c: ConditionLeaf[]) => void; onUniverseChange: (u: ScreenerUniverse) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const expressionInput = useRef<HTMLTextAreaElement>(null);
  const expressionValue = expression ?? defaultExpression(conditions.length);
  const selectionScope = JSON.stringify([expressionScope ?? null, conditions.map(c => c.id)]);
  const [selection, setSelection] = useState({ text: expressionValue, scope: selectionScope,
    start: expressionValue.length, end: expressionValue.length });
  const currentSelection = selection.text === expressionValue && selection.scope === selectionScope
    ? selection : { start: expressionValue.length, end: expressionValue.length };
  const rangeSelected = currentSelection.start !== currentSelection.end;
  const undo = useExpressionUndo(expressionValue,
    selectionScope,
    value => onExpressionChange?.(value), expressionInput);
  const syncSelection = useCallback(() => {
    const input = expressionInput.current;
    if (!input) return;
    const next = { text: input.value, scope: selectionScope, start: input.selectionStart, end: input.selectionEnd };
    setSelection(previous => previous.text === next.text && previous.scope === next.scope
      && previous.start === next.start && previous.end === next.end ? previous : next);
  }, [selectionScope]);
  // Native onSelect can skip programmatic restores when its cached offsets match.
  // The undo hook restores the DOM selection in its earlier layout effect.
  useLayoutEffect(syncSelection, [expressionValue, syncSelection]);
  const rememberSelection = () => {
    undo.rememberSelection();
    syncSelection();
  };
  const invalidExpression = !!expressionError(expression, conditions.length);
  const insert = (token: string) => {
    const value = expressionValue;
    const input = expressionInput.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    if (start !== end) return;
    const left = value.slice(0, start), right = value.slice(end);
    const text = `${left && !/[\s(]$/.test(left) ? ' ' : ''}${token}${right && !/^[\s)]/.test(right) ? ' ' : ''}`;
    const next = left + text + right;
    if (next.length > MAX_EXPRESSION_LENGTH) return;
    undo.change(next, { start: start + text.length, end: start + text.length });
  };
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Outside-mousedown / Escape dismissal for the add-condition menu only.
  useDismissablePopover(menuOpen, wrapRef, () => setMenuOpen(false));
  // 버튼 아래로 떠 화면 밖으로 넘치면 가장자리로 슬라이드(공용 클램프).
  const { ref: menuRef, left, top } = useClampedFixedPosition<HTMLUListElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  const toggleMenu = () => {
    const next = !menuOpen;
    if (next && btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
    setMenuOpen(next);
  };
  const add = (t: ConditionType) => { if (invalidExpression) return; onConditionsChange([...conditions, makeLeaf(t)]); setMenuOpen(false); };
  const replace = (id: string, next: ConditionLeaf) => onConditionsChange(conditions.map((c) => c.id === id ? next : c));
  const remove = (id: string) => { if (!invalidExpression) onConditionsChange(conditions.filter((c) => c.id !== id)); };
  const moveTo = (targetId: string) => {
    if (invalidExpression || !draggingId || draggingId === targetId) return;
    const from = conditions.findIndex((c) => c.id === draggingId);
    const to = conditions.findIndex((c) => c.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...conditions];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onConditionsChange(next);
    setDraggingId(null);
  };
  const handleDragStart = (id: string, event: DragEvent<HTMLButtonElement>) => {
    setDraggingId(id);
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  };

  return (
    <div className="flex h-full flex-col gap-sm min-h-0 overflow-auto p-md">
      {/* Header: [조건 추가 (flex-1)] [사전필터 버튼]. 전역 사전필터는 버튼이 여는
          UniverseFilterModal 로 이동(빌더 카드 정리). */}
      <div className="flex gap-sm items-stretch">
        <div ref={wrapRef} className="relative flex-1">
          <button ref={btnRef} type="button" aria-label="조건 추가" aria-expanded={menuOpen} disabled={invalidExpression} onClick={toggleMenu}
            className="w-full border border-dashed border-border-strong rounded-md text-fg-dim text-sm py-2 hover:bg-bg-input-hover">
            <AppIcon name="plus" /> 조건 추가 <ChevronIcon collapsed={false} size={14} />
          </button>
          {menuOpen && anchorRect && (
            <ul ref={menuRef} role="menu"
              className="bg-bg-card border border-border-strong rounded-lg shadow-overlay max-h-[calc(100vh-16px)] overflow-y-auto z-50"
              style={{ position: 'fixed', top, left, width: anchorRect.width }}>
              {CONDITION_GROUPS.map(([label, types]) => (
                <li key={label} role="none">
                  <div className="px-3 pt-2 pb-1 text-2xs font-semibold uppercase text-fg-dim">{label}</div>
                  <ul role="none">
                    {types.map((t) => (
                      <li key={t} role="none"><button type="button" role="menuitem" aria-label={CONDITION_CATALOG[t].label} onClick={() => add(t)}
                        className="w-full text-left px-3 py-2 text-sm text-fg hover:bg-bg-input-hover">{CONDITION_CATALOG[t].label}</button></li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
        <UniverseFilterButton universe={universe} onChange={onUniverseChange} />
      </div>

      {conditions.length > 0 && onExpressionChange && <ConditionExpressionEditor
        conditions={conditions} expression={expression} onChange={undo.change}
        inputRef={expressionInput} onInsert={insert} onTextChange={undo.onTextChange}
        selection={currentSelection}
        onKeyDown={undo.onKeyDown} onSelectionChange={rememberSelection} />}
      {conditions.map((leaf, index) => (
        <ConditionRow calculationPolicy={calculationPolicy} key={leaf.id} leaf={leaf} letter={conditionLabel(index)}
          onInsertLetter={onExpressionChange && !rangeSelected ? () => insert(conditionLabel(index)) : undefined}
          structureDisabled={invalidExpression}
          draggable={!invalidExpression && conditions.length > 1}
          dragging={draggingId === leaf.id}
          onDragStart={(event) => handleDragStart(leaf.id, event)}
          onDragOver={handleDragOver}
          onDrop={() => moveTo(leaf.id)}
          onDragEnd={() => setDraggingId(null)}
          onChange={(n) => replace(leaf.id, n)}
          onRemove={() => remove(leaf.id)} />
      ))}
      {children}
    </div>
  );
}
