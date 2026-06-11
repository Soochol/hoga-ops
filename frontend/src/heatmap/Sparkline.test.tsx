import { render } from '@testing-library/react';
import { it, expect } from 'vitest';
import { Sparkline } from './Sparkline';

it('상승 추세(연 이후 last>first) → stroke = --price-up(적)', () => {
  const { container } = render(<Sparkline series={[1, 1.5, 3]} />);
  expect(container.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-up)');
});

it('하락 추세 → stroke = --price-down(청)', () => {
  const { container } = render(<Sparkline series={[3, 2, 1]} />);
  expect(container.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-down)');
});

it('평탄(|Δ|<EPS_PP) → stroke = --fg-dim(중립)', () => {
  const { container } = render(<Sparkline series={[5, 5, 5]} />);
  expect(container.querySelector('path')?.getAttribute('stroke')).toBe('var(--fg-dim)');
});

it('점 <2 → 렌더 없음(그리드 칸은 부모가 비움)', () => {
  const { container } = render(<Sparkline series={[1]} />);
  expect(container.querySelector('svg')).toBeNull();
});

it('series undefined → 렌더 없음', () => {
  const { container } = render(<Sparkline series={undefined} />);
  expect(container.querySelector('svg')).toBeNull();
});

it('path 점 개수 = series 길이(L 커맨드 n-1개 + M 1개)', () => {
  const { container } = render(<Sparkline series={[1, 2, 3, 4]} />);
  const d = container.querySelector('path')!.getAttribute('d')!;
  expect((d.match(/[ML]/g) ?? []).length).toBe(4);
});
