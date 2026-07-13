import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChevronIcon, DoubleChevronIcon } from './ChevronIcon';

describe('ChevronIcon', () => {
  it('rotates -90deg when collapsed and stays upright when expanded', () => {
    const { container, rerender } = render(<ChevronIcon collapsed={false} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class') ?? '').not.toContain('-rotate-90');
    expect(svg).toHaveClass('transition-transform');

    rerender(<ChevronIcon collapsed />);
    expect(container.querySelector('svg')!.getAttribute('class') ?? '').toContain('-rotate-90');
  });

  it('is decorative (aria-hidden)', () => {
    const { container } = render(<ChevronIcon collapsed={false} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders two chevron paths for the double variant', () => {
    const { container } = render(<DoubleChevronIcon direction="left" />);
    expect(container.querySelectorAll('svg path')).toHaveLength(2);
  });
});
