import { expressionError, MAX_EXPRESSION_LENGTH } from './conditionExpression';

export interface ExpressionSelection { start: number; end: number }
export interface ExpressionEdit extends ExpressionSelection { text: string }

/** Only complete operands/groups can be wrapped; never split a condition such as AA. */
export function groupExpression(text: string, { start, end }: ExpressionSelection, count: number): ExpressionEdit | null {
  if (start === end || text.length + 2 > MAX_EXPRESSION_LENGTH) return null;
  if (/[a-z]/i.test(text[start - 1] ?? '') && /[a-z]/i.test(text[start] ?? '')) return null;
  if (/[a-z]/i.test(text[end - 1] ?? '') && /[a-z]/i.test(text[end] ?? '')) return null;
  const selected = text.slice(start, end);
  if (!selected.trim() || expressionError(selected, count)) return null;
  const next = `${text.slice(0, start)}(${selected})${text.slice(end)}`;
  if (expressionError(next, count)) return null;
  return { text: next, start: start + 1, end: end + 1 };
}

/** Native textarea double-click selects a word, sometimes including trailing whitespace. */
export function toggleExpressionOperator(text: string, { start, end }: ExpressionSelection): ExpressionEdit | null {
  const selected = text.slice(start, end);
  const match = /^(\s*)(AND|OR)(\s*)$/i.exec(selected);
  if (!match) return null;
  const from = start + match[1].length, to = end - match[3].length;
  if (/[a-z]/i.test(text[from - 1] ?? '') || /[a-z]/i.test(text[to] ?? '')) return null;
  const replacement = match[2].toUpperCase() === 'AND' ? 'OR' : 'AND';
  const next = text.slice(0, from) + replacement + text.slice(to);
  if (next.length > MAX_EXPRESSION_LENGTH) return null;
  return { text: next, start: from, end: from + replacement.length };
}

/** At a bracket or immediately after one, highlight that exact pair, including nested groups. */
export function matchingExpressionPair(text: string, { start, end }: ExpressionSelection): [number, number] | null {
  if (start !== end) return null;
  const at = /[()]/.test(text[start] ?? '') ? start : start - 1;
  const bracket = text[at];
  if (bracket !== '(' && bracket !== ')') return null;
  const step = bracket === '(' ? 1 : -1;
  let depth = 0;
  for (let i = at; i >= 0 && i < text.length; i += step) {
    if (text[i] === bracket) depth++;
    else if (text[i] === (bracket === '(' ? ')' : '(')) depth--;
    if (!depth) return step === 1 ? [at, i] : [i, at];
  }
  return null;
}
