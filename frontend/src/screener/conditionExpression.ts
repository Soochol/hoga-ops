import type { ConditionLeaf } from '../api/screener';

export type ExpressionToken = number | 'AND' | 'OR';
export const MAX_EXPRESSION_LENGTH = 10_000;

export function conditionLabel(index: number): string {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + (n - 1) % 26) + label;
  }
  return label;
}

export function defaultExpression(count: number): string {
  return Array.from({ length: count }, (_, i) => conditionLabel(i)).join(' AND ');
}

/** Mirrors screener_expression.py: iterative parsing, AND before OR, no eval. */
export function parseExpression(expression: string | null | undefined, count: number): ExpressionToken[] {
  if (expression == null) {
    return Array.from({ length: count }, (_, i): ExpressionToken[] => i === 0 ? [i] : [i, 'AND']).flat();
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) throw new Error('조합식은 10,000자 이내로 입력해 주세요.');
  const text = expression.trim();
  if (!text) {
    if (count === 0) return [];
    throw new Error('조건 조합식을 입력해 주세요.');
  }
  const labels = new Map(Array.from({ length: count }, (_, i) => [conditionLabel(i), i]));
  const output: ExpressionToken[] = [];
  const operators: ('AND' | 'OR' | '(')[] = [];
  const precedence = { AND: 2, OR: 1 };
  const tokenPattern = /\s*(AND\b|OR\b|그리고|또는|[A-Z]+|[()])/iy;
  let position = 0;
  let expectCondition = true;
  while (position < text.length) {
    tokenPattern.lastIndex = position;
    const match = tokenPattern.exec(text);
    if (!match) throw new Error('조합식에는 조건 문자, AND, OR, 괄호만 사용할 수 있습니다.');
    const token = match[1] === '그리고' ? 'AND' : match[1] === '또는' ? 'OR' : match[1].toUpperCase();
    position = tokenPattern.lastIndex;
    if (token === '(') {
      if (!expectCondition) throw new Error('조건 사이에 AND 또는 OR를 넣어 주세요.');
      operators.push(token);
    } else if (token === ')') {
      if (expectCondition) throw new Error('괄호 안에 조건을 입력해 주세요.');
      while (operators.length && operators.at(-1) !== '(') output.push(operators.pop() as 'AND' | 'OR');
      if (!operators.length) throw new Error('여는 괄호가 필요합니다.');
      operators.pop();
    } else if (token === 'AND' || token === 'OR') {
      if (expectCondition) throw new Error('AND 또는 OR 앞에 조건이 필요합니다.');
      while (operators.length) {
        const top = operators.at(-1)!;
        if (top === '(' || precedence[top] < precedence[token]) break;
        output.push(operators.pop() as 'AND' | 'OR');
      }
      operators.push(token);
      expectCondition = true;
    } else {
      if (!expectCondition) throw new Error('조건 사이에 AND 또는 OR를 넣어 주세요.');
      const index = labels.get(token);
      if (index === undefined) throw new Error(`${token}에 해당하는 조건이 없습니다.`);
      output.push(index);
      expectCondition = false;
    }
  }
  if (expectCondition) throw new Error('AND 또는 OR 뒤에 조건이 필요합니다.');
  while (operators.length) {
    const token = operators.pop()!;
    if (token === '(') throw new Error('닫는 괄호가 필요합니다.');
    output.push(token);
  }
  return output;
}

export function expressionError(expression: string | null | undefined, count: number): string | null {
  try { parseExpression(expression, count); return null; }
  catch (error) { return error instanceof Error ? error.message : '조건 조합식을 확인해 주세요.'; }
}

/** Remap references without choosing parentheses or reformatting the user's formula. */
export function reconcileExpression(expression: string | null, before: ConditionLeaf[], after: ConditionLeaf[]): string | null {
  if (expression == null || before.map(c => c.id).join('\0') === after.map(c => c.id).join('\0')) return expression;
  if (!after.length) return null;
  const indices = new Map(after.map((c, i) => [c.id, i]));
  parseExpression(expression, before.length);
  const labels = new Map(before.map((c, i) => [conditionLabel(i), c.id]));
  const stack: { text: string | null; start: number; end: number }[] = [];
  const operators: { token: string; start: number }[] = [];
  const precedence: Record<string, number> = { AND: 2, OR: 1 };
  const reduce = () => {
    operators.pop();
    const right = stack.pop()!, left = stack.pop()!;
    stack.push({ start: left.start, end: right.end, text: left.text && right.text
      ? left.text + expression.slice(left.end, right.start) + right.text : left.text ?? right.text });
  };
  for (const match of expression.matchAll(/AND\b|OR\b|그리고|또는|[A-Z]+|[()]/gi)) {
    const token = match[0] === '그리고' ? 'AND' : match[0] === '또는' ? 'OR' : match[0].toUpperCase();
    const start = match.index, end = start + match[0].length;
    if (token === '(') operators.push({ token, start });
    else if (token === ')') {
      while (operators.at(-1)?.token !== '(') reduce();
      const open = operators.pop()!, inside = stack.pop()!;
      stack.push({ start: open.start, end, text: inside.text == null ? null
        : expression.slice(open.start, inside.start) + inside.text + expression.slice(inside.end, end) });
    } else if (token === 'AND' || token === 'OR') {
      while (operators.length && operators.at(-1)!.token !== '('
        && precedence[operators.at(-1)!.token] >= precedence[token]) reduce();
      operators.push({ token, start });
    } else {
      const next = indices.get(labels.get(token)!);
      const label = next === undefined ? null : conditionLabel(next);
      stack.push({ start, end, text: label && match[0] === match[0].toLowerCase() ? label.toLowerCase() : label });
    }
  }
  while (operators.length) reduce();
  const root = stack[0];
  let result = root?.text == null ? '' : expression.slice(0, root.start) + root.text + expression.slice(root.end);
  const oldIds = new Set(before.map(c => c.id));
  after.forEach((c, i) => {
    if (!oldIds.has(c.id)) result = result ? `${result} AND ${conditionLabel(i)}` : conditionLabel(i);
  });
  // Removing the only referenced leaf must not silently activate previously unused leaves.
  return result ?? '';
}

export function referencedConditions(conditions: ConditionLeaf[], expression?: string | null): ConditionLeaf[] {
  const used = new Set(parseExpression(expression, conditions.length).filter(t => typeof t === 'number'));
  return conditions.filter((_, i) => used.has(i));
}

export function evaluateExpression(tokens: ExpressionToken[], matches: Set<number>): boolean {
  const stack: boolean[] = [];
  for (const token of tokens) {
    if (typeof token === 'number') stack.push(matches.has(token));
    else {
      const right = stack.pop()!, left = stack.pop()!;
      stack.push(token === 'AND' ? left && right : left || right);
    }
  }
  return stack[0] ?? true;
}
