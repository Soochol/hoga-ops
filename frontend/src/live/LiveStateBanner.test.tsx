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

  // credentials_missing 행 테스트는 그 배너가 도달 불가 판정으로 제거되며 같이 내렸다.
  // 액션 링크 렌더는 아래 realtime_unavailable 케이스가 그대로 덮는다.

  it('renders stacked kis_token_expired banner without action', () => {
    render_(<LiveStateBanner primary={null} stack={['kis_token_expired']} />);
    expect(screen.getByText(/토큰이 만료/)).toBeInTheDocument();
  });

  it('shows realtime_unavailable banner with a settings action (F2)', () => {
    render_(<LiveStateBanner primary="realtime_unavailable" stack={[]} />);
    expect(screen.getByText(/실시간 미가동/)).toBeInTheDocument();
    expect(screen.getByText('설정').getAttribute('href')).toBe('/settings');
  });
});
