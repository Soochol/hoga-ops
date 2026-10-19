import { useId, type RefObject } from 'react';
import type { ConditionLeaf } from '../api/screener';
import { catalogEntry } from './catalog';
import { conditionLabel, defaultExpression, expressionError, MAX_EXPRESSION_LENGTH, parseExpression } from './conditionExpression';
import './ConditionEditor.css';

export function ConditionExpressionEditor({ conditions, expression, onChange, inputRef, onInsert }: {
  conditions: ConditionLeaf[];
  expression?: string | null;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  onInsert: (token: string) => void;
}) {
  const id = useId();
  const error = expressionError(expression, conditions.length);
  const used = new Set(error ? [] : parseExpression(expression, conditions.length));
  const unused = conditions.map((_, i) => i).filter(i => !used.has(i));
  return <section className="condition-expression" aria-label="조건 조합">
    <div className="condition-expression-heading">
      <label htmlFor={id}>조건 조합</label>
      <button type="button" onClick={() => onChange(defaultExpression(conditions.length))}
        className="condition-expression-button">모두 AND</button>
      <button type="button" onClick={() => onChange(conditions.map((_, i) => conditionLabel(i)).join(' OR '))}
        className="condition-expression-button">모두 OR</button>
    </div>
    <textarea ref={inputRef} id={id} aria-label="조건 조합식" value={expression ?? defaultExpression(conditions.length)}
      aria-invalid={!!error} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
      onChange={event => onChange(event.target.value)} maxLength={MAX_EXPRESSION_LENGTH}
      rows={2} spellCheck={false} autoCapitalize="characters" placeholder="A AND (B OR C)"
      className="condition-expression-input font-data" />
    <div className="condition-expression-tools" aria-label="조합식 빠른 입력">
      {conditions.map((leaf, i) => <button key={leaf.id} type="button"
        aria-label={`${conditionLabel(i)} ${catalogEntry(leaf.type).label} 조합식에 입력`}
        title={`${conditionLabel(i)} · ${catalogEntry(leaf.type).label}`}
        className="condition-expression-button condition-expression-letter"
        onClick={() => onInsert(conditionLabel(i))}>{conditionLabel(i)}</button>)}
      {['AND', 'OR', '(', ')'].map(token => <button key={token} type="button"
        aria-label={`${token} 조합식에 입력`} className="condition-expression-button"
        onClick={() => onInsert(token)}>{token}</button>)}
    </div>
    <p id={`${id}-help`} className="condition-expression-help">괄호 안을 먼저 계산하고, AND는 OR보다 먼저 적용합니다.</p>
    {error && <p id={`${id}-error`} role="alert" className="condition-expression-error">{error}</p>}
    {!error && unused.length > 0 && <p role="status" className="condition-expression-help">
      검색에 사용하지 않는 조건: {unused.map(conditionLabel).join(', ')}
    </p>}
  </section>;
}
