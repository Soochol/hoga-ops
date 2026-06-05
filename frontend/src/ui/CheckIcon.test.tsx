import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CheckIcon } from './CheckIcon';

describe('CheckIcon', () => {
  it('renders an accent-filled circle when filled', () => {
    const { container } = render(<CheckIcon filled />);
    expect(container.querySelector('circle')?.getAttribute('fill')).toBe('var(--accent)');
  });
  it('renders a hollow dimmer ring when not filled', () => {
    const { container } = render(<CheckIcon filled={false} />);
    const circle = container.querySelector('circle');
    expect(circle?.getAttribute('fill')).toBe('none');
    expect(circle?.getAttribute('stroke')).toBe('var(--fg-dimmer)');
  });
  it('sizes via the size prop (default 18)', () => {
    const { container } = render(<CheckIcon filled size={16} />);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('16');
  });
});
