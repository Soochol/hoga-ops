import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import RightRail from './RightRail';
import { useRightRailStore } from '../state/rightRail';

describe('RightRail', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useRightRailStore.setState({ panelOpen: false });
  });

  it('관심 item toggles the panel', () => {
    render(<RightRail />);
    const btn = screen.getByLabelText('관심종목 패널 토글');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(useRightRailStore.getState().panelOpen).toBe(true);
    fireEvent.click(btn);
    expect(useRightRailStore.getState().panelOpen).toBe(false);
  });

  it('chevron toggles the panel (rail stays fixed)', () => {
    render(<RightRail />);
    fireEvent.click(screen.getByLabelText('관심종목 패널 열기'));
    expect(useRightRailStore.getState().panelOpen).toBe(true);
  });

  it('chevron shows the close affordance when the panel is open', () => {
    useRightRailStore.setState({ panelOpen: true });
    render(<RightRail />);
    expect(screen.getByLabelText('관심종목 패널 닫기')).toBeInTheDocument();
    // 관심 item is always present — the rail does not collapse.
    expect(screen.getByLabelText('관심종목 패널 토글')).toBeInTheDocument();
  });
});
