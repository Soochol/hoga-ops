import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import RightRail from './RightRail';
import { useRightRailStore } from '../state/rightRail';

describe('RightRail', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useRightRailStore.setState({ panelOpen: false, railCollapsed: false });
  });

  it('관심 button toggles the panel', () => {
    render(<RightRail />);
    const btn = screen.getByLabelText('관심종목 패널 토글');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(useRightRailStore.getState().panelOpen).toBe(true);
  });

  it('chevron collapses the rail and hides the 관심 button', () => {
    render(<RightRail />);
    fireEvent.click(screen.getByLabelText('레일 접기'));
    expect(useRightRailStore.getState().railCollapsed).toBe(true);
    expect(screen.queryByLabelText('관심종목 패널 토글')).toBeNull();
  });

  it('collapsed handle expands the rail', () => {
    useRightRailStore.setState({ panelOpen: false, railCollapsed: true });
    render(<RightRail />);
    fireEvent.click(screen.getByLabelText('레일 펼치기'));
    expect(useRightRailStore.getState().railCollapsed).toBe(false);
  });
});
