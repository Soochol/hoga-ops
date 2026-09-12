import { expect, it } from 'vitest';
import { textLayout } from './textLayout';

it('normalizes pasted line endings, preserves empty lines and measures the widest line', () => {
  expect(textLayout('a\r\n\r\nlong\rz', 20, (line) => line.length * 10)).toEqual({
    lines: ['a', '', 'long', 'z'], width: 40, height: 95, lineHeight: 25,
  });
});

it('keeps existing single-line drawing dimensions', () => {
  expect(textLayout('abc', 13, () => 30)).toMatchObject({ width: 30, height: 13 });
});
