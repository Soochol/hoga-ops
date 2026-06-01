import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { FunnelIcon } from './FunnelIcon';

describe('FunnelIcon', () => {
  it('fills with currentColor when filled', () => {
    const { container } = render(<FunnelIcon filled className="x" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('class')).toBe('x');
  });

  it('uses no fill when not filled', () => {
    const { container } = render(<FunnelIcon filled={false} />);
    expect(container.querySelector('svg')!.getAttribute('fill')).toBe('none');
  });
});
