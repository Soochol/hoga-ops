import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { HeartIcon } from './HeartIcon';

describe('HeartIcon', () => {
  it('fills with currentColor when filled', () => {
    const { container } = render(<HeartIcon filled />);
    expect(container.querySelector('svg')?.getAttribute('fill')).toBe('currentColor');
  });
  it('is outline (fill=none) when not filled', () => {
    const { container } = render(<HeartIcon filled={false} />);
    expect(container.querySelector('svg')?.getAttribute('fill')).toBe('none');
  });
});
