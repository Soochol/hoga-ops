import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { LiveStateBanner } from './LiveStateBanner';

function render_(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe('LiveStateBanner', () => {
  it('renders nothing when primary is null and stack is empty', () => {
    const { container } = render_(<LiveStateBanner primary={null} stack={[]} />);
    expect(container.querySelector('[data-testid="live-state-banner"]')).toBeNull();
  });

  it('shows kis_credentials_missing banner with action link', () => {
    render_(<LiveStateBanner primary="kis_credentials_missing" stack={[]} />);
    expect(screen.getByText(/KIS 자격증명/)).toBeInTheDocument();
    expect(screen.getByText('설정').getAttribute('href')).toBe('/settings');
  });

  it('renders stacked kis_token_expired banner without action', () => {
    render_(<LiveStateBanner primary={null} stack={['kis_token_expired']} />);
    expect(screen.getByText(/토큰이 만료/)).toBeInTheDocument();
  });
});
