import { describe, expect, it } from 'vitest';
import { groupExpression, matchingExpressionPair, toggleExpressionOperator, ungroupExpression } from './expressionEditing';
import { MAX_EXPRESSION_LENGTH } from './conditionExpression';

describe('groupExpression', () => {
  it('wraps only the selected complete expression and keeps its contents selected', () => {
    expect(groupExpression('A AND B OR C', { start: 0, end: 7 }, 3))
      .toEqual({ text: '(A AND B) OR C', start: 1, end: 8 });
    expect(groupExpression('A AND (B OR C)', { start: 6, end: 14 }, 3))
      .toEqual({ text: 'A AND ((B OR C))', start: 7, end: 15 });
  });

  it('rejects empty, incomplete, unbalanced or partial-letter selections', () => {
    for (const [text, start, end, count] of [
      ['A AND B', 0, 0, 2], ['A AND B', 1, 2, 2], ['A AND B', 0, 5, 2],
      ['A AND (B OR C)', 0, 8, 3], ['AA AND B', 0, 1, 27], ['AA AND B', 1, 2, 27],
    ] as const) expect(groupExpression(text, { start, end }, count)).toBeNull();
  });

  it('does not exceed the expression length limit', () => {
    expect(groupExpression('A' + ' '.repeat(MAX_EXPRESSION_LENGTH - 2), { start: 0, end: 1 }, 1)).toBeNull();
  });
});

describe('ungroupExpression', () => {
  it('removes only the selected outer pair and keeps nested groups and the rest of the expression', () => {
    const text = 'A OR (B AND (C OR D))';
    expect(ungroupExpression(text, { start: 5, end: text.length }, 4))
      .toEqual({ text: 'A OR B AND (C OR D)', start: 5, end: 19 });
    expect(ungroupExpression('((A AND B))', { start: 0, end: 11 }, 2))
      .toEqual({ text: '(A AND B)', start: 0, end: 9 });
  });

  it('also accepts the exact contents kept selected after grouping', () => {
    const edit = groupExpression('A AND B OR C', { start: 0, end: 7 }, 3)!;
    expect(ungroupExpression(edit.text, edit, 3))
      .toEqual({ text: 'A AND B OR C', start: 0, end: 7 });
    expect(ungroupExpression(' ( A AND B ) ', { start: 3, end: 10 }, 2))
      .toEqual({ text: '  A AND B  ', start: 1, end: 10 });
  });

  it('preserves whitespace around a selected group and separates tokens when needed', () => {
    expect(ungroupExpression('A OR  (B AND C)  ', { start: 4, end: 17 }, 3))
      .toEqual({ text: 'A OR  B AND C  ', start: 6, end: 13 });
    expect(ungroupExpression('A AND(B OR C)OR A', { start: 5, end: 13 }, 3))
      .toEqual({ text: 'A AND B OR C OR A', start: 6, end: 12 });
  });

  it('rejects empty, partial, unmatched and multiple independent groups', () => {
    for (const [text, start, end] of [
      ['(A AND B)', 0, 0], ['(A AND B)', 1, 2], ['(A AND B)', 0, 4],
      ['(A AND B', 0, 8], ['(A AND B)', 3, 8], ['(A) AND (B)', 0, 11],
      ['( )', 1, 2], ['()', 0, 2], ['A AND B', 0, 7],
    ] as const) expect(ungroupExpression(text, { start, end }, 2)).toBeNull();
  });
});

describe('toggleExpressionOperator', () => {
  it('toggles whole operators, preserving surrounding whitespace and selecting the new operator', () => {
    expect(toggleExpressionOperator('A AND B', { start: 2, end: 6 }))
      .toEqual({ text: 'A OR B', start: 2, end: 4 });
    expect(toggleExpressionOperator('(A or B)', { start: 3, end: 5 }))
      .toEqual({ text: '(A AND B)', start: 3, end: 6 });
  });

  it('never changes condition labels, substrings or multi-token selections', () => {
    expect(toggleExpressionOperator('A AND B', { start: 0, end: 1 })).toBeNull();
    expect(toggleExpressionOperator('A AND B', { start: 0, end: 7 })).toBeNull();
    expect(toggleExpressionOperator('ORANGE', { start: 0, end: 2 })).toBeNull();
    expect(toggleExpressionOperator('A OR B' + ' '.repeat(MAX_EXPRESSION_LENGTH - 6), { start: 2, end: 4 })).toBeNull();
  });
});

describe('matchingExpressionPair', () => {
  it('finds the corresponding nested pair from either side of a bracket', () => {
    const text = 'A AND (B OR (C AND D))';
    for (const caret of [6, 7, 21, 22]) {
      expect(matchingExpressionPair(text, { start: caret, end: caret })).toEqual([6, 21]);
    }
    for (const caret of [12, 13, 20]) {
      expect(matchingExpressionPair(text, { start: caret, end: caret })).toEqual([12, 20]);
    }
  });

  it('ignores unmatched brackets, text positions and selected ranges', () => {
    expect(matchingExpressionPair('(A AND B', { start: 0, end: 0 })).toBeNull();
    expect(matchingExpressionPair('A AND B)', { start: 8, end: 8 })).toBeNull();
    expect(matchingExpressionPair('(A AND B)', { start: 4, end: 4 })).toBeNull();
    expect(matchingExpressionPair('(A AND B)', { start: 0, end: 9 })).toBeNull();
  });
});
