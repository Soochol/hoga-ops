import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TrashIcon } from './TrashIcon';

describe('TrashIcon', () => {
  it('renders an svg outlined with currentColor (no fill)', () => {
    const { container } = render(<TrashIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('fill')).toBe('none');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
  });

  it('applies the className for sizing', () => {
    const { container } = render(<TrashIcon className="w-[1em] h-[1em]" />);
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('w-[1em]');
  });

  it('is aria-hidden (decorative — the button carries the label)', () => {
    const { container } = render(<TrashIcon />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
