import { render } from '@testing-library/react';
import { it, expect } from 'vitest';
import { CandleGlyph } from './CandleGlyph';

const bodyFill = (c: HTMLElement) =>
  c.querySelector('.candle-glyph rect:last-child')?.getAttribute('fill');

it('양봉(close>open) → --price-up', () => {
  const { container } = render(<CandleGlyph open={100} high={120} low={95} close={115} />);
  expect(bodyFill(container)).toBe('var(--price-up)');
});

it('음봉(close<open) → --price-down', () => {
  const { container } = render(<CandleGlyph open={115} high={120} low={95} close={100} />);
  expect(bodyFill(container)).toBe('var(--price-down)');
});

it('도지(close==open) → --fg-dim (>= 아님)', () => {
  const { container } = render(<CandleGlyph open={100} high={110} low={90} close={100} />);
  expect(bodyFill(container)).toBe('var(--fg-dim)');
});

it('결측(null) → 렌더 없음', () => {
  const { container } = render(<CandleGlyph open={null} high={120} low={95} close={115} />);
  expect(container.querySelector('.candle-glyph')).toBeNull();
});

it('모순(high<low) → 렌더 없음', () => {
  const { container } = render(<CandleGlyph open={100} high={90} low={95} close={100} />);
  expect(container.querySelector('.candle-glyph')).toBeNull();
});

it('limit-lock(high==low) → 심지·몸통 최소 1px 렌더', () => {
  const { container } = render(<CandleGlyph open={100} high={100} low={100} close={100} />);
  const rects = container.querySelectorAll('.candle-glyph rect');
  expect(rects.length).toBe(2);
  rects.forEach((r) => expect(Number(r.getAttribute('height'))).toBeGreaterThanOrEqual(1));
});
