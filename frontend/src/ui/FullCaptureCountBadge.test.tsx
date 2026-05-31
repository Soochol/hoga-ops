import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { FullCaptureCountBadge } from './FullCaptureCountBadge';

describe('FullCaptureCountBadge', () => {
  it('renders "—" when n is undefined (no row yet → first-ever capture)', () => {
    const { container } = render(<FullCaptureCountBadge n={undefined} />);
    const span = container.querySelector('span');
    expect(span?.textContent).toBe('—');
    // No count badge tooltip on the placeholder.
    expect(span?.getAttribute('title')).toBeNull();
  });

  it('renders faint "×1" with the lower-bound tooltip when n is null (legacy meta)', () => {
    const { container } = render(<FullCaptureCountBadge n={null} />);
    const span = container.querySelector('span');
    expect(span?.textContent).toBe('×1');
    expect(span?.getAttribute('title')).toBe('Full Capture 횟수 미기록 (≥1로 간주)');
    expect(span?.className).toContain('text-fg-dimmer');
  });

  it('renders "×1" with an honest tooltip when n is exactly 1', () => {
    const { container } = render(<FullCaptureCountBadge n={1} />);
    const span = container.querySelector('span');
    expect(span?.textContent).toBe('×1');
    expect(span?.getAttribute('title')).toBe('Full Capture 누적 1회');
  });

  it('renders "×3" with the standard tone when n is 3', () => {
    const { container } = render(<FullCaptureCountBadge n={3} />);
    const span = container.querySelector('span');
    expect(span?.textContent).toBe('×3');
    expect(span?.getAttribute('title')).toBe('Full Capture 누적 3회');
    expect(span?.className).toContain('text-fg-dim');
  });
});
