import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StudyRepairedBadge } from './StudyRepairedBadge';

describe('StudyRepairedBadge', () => {
  it('renders nothing when there are no repaired dates', () => {
    const { container } = render(<StudyRepairedBadge dates={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the repaired day count and no-orderbook-indicator caveat', () => {
    render(<StudyRepairedBadge dates={['20260518', '20260519']} />);
    const badge = screen.getByTestId('study-repaired-candle-badge');
    expect(badge.textContent).toContain('2일');
    expect(badge.textContent).toContain('호가 지표 없음');
  });

  it('lists the repaired dates in the tooltip', () => {
    render(<StudyRepairedBadge dates={['20260518']} />);
    const badge = screen.getByTestId('study-repaired-candle-badge');
    expect(badge.getAttribute('title')).toContain('20260518');
  });
});
