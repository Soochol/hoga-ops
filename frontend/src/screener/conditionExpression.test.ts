import { describe, expect, it } from 'vitest';
import casesText from '../../tests/fixtures/screener-expression-cases.json?raw';
import type { ConditionLeaf } from '../api/screener';
import { conditionLabel, defaultExpression, evaluateExpression, parseExpression, reconcileExpression } from './conditionExpression';

const cases = JSON.parse(casesText) as { expression: string | null; count: number; postfix?: (number | string)[] }[];
const leaves: ConditionLeaf[] = ['a', 'b', 'c'].map(id => ({ id, type: 'trade_value', params: { min_eok: 100 } }));

describe('condition expressions', () => {
  it.each(cases)('shares backend grammar: $expression ($count conditions)', test => {
    if (test.postfix) expect(parseExpression(test.expression, test.count)).toEqual(test.postfix);
    else expect(() => parseExpression(test.expression, test.count)).toThrow();
  });
  it('supports deep nesting, repeated references, and letters after Z', () => {
    expect(parseExpression('('.repeat(2000) + 'A' + ')'.repeat(2000), 1)).toEqual([0]);
    expect([0, 25, 26, 701, 702].map(conditionLabel)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
    expect(defaultExpression(3)).toBe('A AND B AND C');
  });
  it('retains the same leaf meaning after reorder and removal', () => {
    const reordered = [leaves[2], leaves[0], leaves[1]];
    const expression = reconcileExpression('A AND (B OR C)', leaves, reordered)!;
    expect(expression).toBe('B AND (C OR A)');
    expect(parseExpression(expression, 3)).toEqual([1, 2, 0, 'OR', 'AND']);
    expect(parseExpression(reconcileExpression('A AND (B OR C)', leaves, [leaves[0], leaves[2]])!, 2))
      .toEqual([0, 1, 'AND']);
    expect(reconcileExpression('A', leaves, [leaves[1], leaves[2]])).toBe('');
    expect(reconcileExpression('A', leaves, [])).toBeNull();
  });
  it('ANDs newly added conditions and retains the implicit AND default', () => {
    const more = [...leaves, { ...leaves[0], id: 'd' }];
    expect(reconcileExpression('A OR B', leaves, more)).toBe('A OR B AND D');
    expect(parseExpression(reconcileExpression('A OR B', leaves, more), 4)).toEqual([0, 1, 3, 'AND', 'OR']);
    expect(reconcileExpression(null, leaves, more)).toBeNull();
  });
  it('preserves handwritten brackets, whitespace and operator spelling on structural changes', () => {
    const reordered = [leaves[2], leaves[0], leaves[1]];
    expect(reconcileExpression('  a  그리고 ((b 또는 c))  ', leaves, reordered)).toBe('  b  그리고 ((c 또는 a))  ');
    expect(reconcileExpression('A AND (B OR C)', leaves, [leaves[0], leaves[2]])).toBe('A AND (B)');
    const deep = '('.repeat(2000) + 'A' + ')'.repeat(2000);
    expect(reconcileExpression(deep, leaves, reordered)).toBe('('.repeat(2000) + 'B' + ')'.repeat(2000));
    expect(reconcileExpression('A AND (', leaves, [...leaves])).toBe('A AND (');
  });
  it('evaluates all truth combinations with AND precedence and parentheses', () => {
    for (let mask = 0; mask < 8; mask++) {
      const matches = new Set([0, 1, 2].filter(i => mask & (1 << i)));
      expect(evaluateExpression(parseExpression('A AND (B OR C)', 3), matches))
        .toBe(matches.has(0) && (matches.has(1) || matches.has(2)));
      expect(evaluateExpression(parseExpression('A OR B AND C', 3), matches))
        .toBe(matches.has(0) || matches.has(1) && matches.has(2));
    }
  });
});
