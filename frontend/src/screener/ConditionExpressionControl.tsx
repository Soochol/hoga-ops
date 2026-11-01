import { useRef } from 'react';
import type { ConditionLeaf } from '../api/screener';
import { ConditionExpressionEditor } from './ConditionExpressionEditor';
import { defaultExpression, MAX_EXPRESSION_LENGTH } from './conditionExpression';
import { useExpressionUndo } from './useExpressionUndo';

/** Buttons replace only the user's selection; brackets are always literal input. */
export function ConditionExpressionControl({ conditions, expression, scope, onChange }: {
  conditions: ConditionLeaf[]; expression?: string | null; scope?: string | null; onChange: (text: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const text = expression ?? defaultExpression(conditions.length);
  const undo = useExpressionUndo(text, JSON.stringify([scope, conditions.map(c => c.id)]), onChange, input);
  const insert = (token: string) => {
    const start = input.current?.selectionStart ?? text.length, end = input.current?.selectionEnd ?? start;
    const left = text.slice(0, start), right = text.slice(end);
    const addition = `${left && !/[\s(]$/.test(left) ? ' ' : ''}${token}${right && !/^[\s)]/.test(right) ? ' ' : ''}`;
    const next = left + addition + right;
    if (next.length <= MAX_EXPRESSION_LENGTH) undo.change(next, { start: start + addition.length, end: start + addition.length });
  };
  return <ConditionExpressionEditor conditions={conditions} expression={expression} onChange={undo.change}
    inputRef={input} onInsert={insert} onTextChange={undo.onTextChange} onKeyDown={undo.onKeyDown}
    onSelectionChange={undo.rememberSelection} />;
}
