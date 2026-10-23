import { useId, useLayoutEffect, useRef, useState, type ChangeEventHandler, type KeyboardEventHandler, type RefObject } from 'react';
import type { ConditionLeaf } from '../api/screener';
import { catalogEntry } from './catalog';
import { conditionLabel, defaultExpression, expressionError, MAX_EXPRESSION_LENGTH, parseExpression } from './conditionExpression';
import { groupExpression, matchingExpressionPair, toggleExpressionOperator, ungroupExpression, type ExpressionSelection } from './expressionEditing';
import './ConditionEditor.css';

export function ConditionExpressionEditor({ conditions, expression, onChange, inputRef, onInsert,
  onTextChange, onKeyDown, onSelectionChange, selection }: {
  conditions: ConditionLeaf[];
  expression?: string | null;
  onChange: (value: string, selection?: ExpressionSelection) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  onInsert: (token: string) => void;
  onTextChange: ChangeEventHandler<HTMLTextAreaElement>;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
  onSelectionChange: () => void;
  selection: ExpressionSelection;
}) {
  const id = useId();
  const value = expression ?? defaultExpression(conditions.length);
  const rangeSelected = selection.start !== selection.end;
  const [focused, setFocused] = useState(false);
  const mirror = useRef<HTMLDivElement>(null);
  const pair = focused ? matchingExpressionPair(value, selection) : null;
  const grouped = groupExpression(value, selection, conditions.length);
  const ungrouped = ungroupExpression(value, selection, conditions.length);
  // Match native textarea wrapping, scrollbar width, scrolling and user resizing.
  useLayoutEffect(() => {
    const input = inputRef.current, overlay = mirror.current;
    if (!input || !overlay) return;
    const sync = () => {
      overlay.style.width = `${input.clientWidth}px`;
      overlay.style.height = `${input.clientHeight}px`;
      overlay.scrollTop = input.scrollTop;
      overlay.scrollLeft = input.scrollLeft;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(input);
    input.addEventListener('scroll', sync);
    return () => { observer.disconnect(); input.removeEventListener('scroll', sync); };
  }, [inputRef]);
  const error = expressionError(expression, conditions.length);
  const used = new Set(error ? [] : parseExpression(expression, conditions.length));
  const unused = conditions.map((_, i) => i).filter(i => !used.has(i));
  return <section className="condition-expression" aria-label="조건 조합" onKeyDown={onKeyDown}>
    <div className="condition-expression-heading">
      <label htmlFor={id}>조건 조합</label>
      <button type="button" onClick={() => onChange(defaultExpression(conditions.length))}
        className="condition-expression-button">모두 AND</button>
      <button type="button" onClick={() => onChange(conditions.map((_, i) => conditionLabel(i)).join(' OR '))}
        className="condition-expression-button">모두 OR</button>
    </div>
    <div className="condition-expression-field">
      <div ref={mirror} aria-hidden="true" className="condition-expression-mirror font-data">
        {pair ? <>{value.slice(0, pair[0])}<span className="condition-expression-group">
          <span className="condition-expression-bracket">(</span>{value.slice(pair[0] + 1, pair[1])}
          <span className="condition-expression-bracket">)</span></span>{value.slice(pair[1] + 1)}</> : value}{value.endsWith('\n') ? '\n' : ''}
      </div>
      <textarea ref={inputRef} id={id} aria-label="조건 조합식" value={value}
      aria-invalid={!!error} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
      onChange={event => { onTextChange(event); onSelectionChange(); }} onSelect={onSelectionChange}
      onFocus={() => { setFocused(true); onSelectionChange(); }} onBlur={() => setFocused(false)}
      onDoubleClick={event => {
        const input = event.currentTarget;
        const edit = toggleExpressionOperator(value, { start: input.selectionStart, end: input.selectionEnd });
        if (edit) onChange(edit.text, edit);
      }}
      data-tooltip="AND/OR를 더블클릭하면 서로 전환합니다. 괄호 안을 먼저 계산하고, AND는 OR보다 먼저 적용합니다."
      maxLength={MAX_EXPRESSION_LENGTH}
      aria-keyshortcuts="Control+Z Meta+Z Control+Shift+Z Meta+Shift+Z Control+Y"
      rows={2} spellCheck={false} autoCapitalize="characters" placeholder="A AND (B OR C)"
      className="condition-expression-input font-data" />
    </div>
    <div className="condition-expression-tools" aria-label="조합식 빠른 입력">
      {conditions.map((leaf, i) => <button key={leaf.id} type="button"
        aria-label={`${conditionLabel(i)} ${catalogEntry(leaf.type).label} 조합식에 입력`}
        data-tooltip={`${conditionLabel(i)} · ${catalogEntry(leaf.type).label}`}
        className="condition-expression-button condition-expression-letter"
        disabled={rangeSelected}
        onClick={() => onInsert(conditionLabel(i))}>{conditionLabel(i)}</button>)}
      {['AND', 'OR'].map(token => <button key={token} type="button" disabled={rangeSelected}
        aria-label={`${token} 조합식에 입력`} className="condition-expression-button"
        onClick={() => onInsert(token)}>{token}</button>)}
      <button type="button" className="condition-expression-button" disabled={!grouped}
        data-tooltip={grouped ? '선택한 범위를 괄호로 묶기' : rangeSelected ? '완전한 조건이나 조합식을 선택해 주세요.' : '묶을 범위를 선택하세요.'}
        onMouseDown={event => event.preventDefault()}
        onClick={() => { if (grouped) onChange(grouped.text, grouped); }}>() 묶기</button>
      <button type="button" className="condition-expression-button" disabled={!ungrouped}
        data-tooltip={ungrouped ? '바깥 괄호 한 쌍만 제거하기' : '묶인 그룹 전체나 그룹의 내용 전체를 선택하세요.'}
        onMouseDown={event => event.preventDefault()}
        onClick={() => { if (ungrouped) onChange(ungrouped.text, ungrouped); }}>() 묶기 해제</button>
    </div>
    <p id={`${id}-help`} className="condition-expression-help">{rangeSelected
      ? grouped || ungrouped ? '조건을 추가하려면 선택을 해제하고 입력 위치를 클릭하세요.' : '묶거나 해제할 완전한 조건이나 그룹을 선택하세요.'
      : '범위를 선택해 () 묶기 · AND/OR 더블클릭으로 전환'}</p>
    {error && <p id={`${id}-error`} role="alert" className="condition-expression-error">{error}</p>}
    {!error && unused.length > 0 && <p role="status" className="condition-expression-help">
      검색에 사용하지 않는 조건: {unused.map(conditionLabel).join(', ')}
    </p>}
  </section>;
}
