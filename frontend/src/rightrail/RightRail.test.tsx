import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import RightRail from './RightRail';
import { useRightRailStore } from '../state/rightRail';

describe('RightRail', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useRightRailStore.setState({ activePanel: null, lastPanel: 'watchlist' });
  });

  it('renders both 관심 and 스크리너 items', () => {
    render(<RightRail />);
    expect(screen.getByLabelText('관심종목 패널 토글')).toBeInTheDocument();
    expect(screen.getByLabelText('스크리너 패널 토글')).toBeInTheDocument();
  });

  it('관심 item opens the watchlist panel', () => {
    render(<RightRail />);
    const btn = screen.getByLabelText('관심종목 패널 토글');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('스크리너 item opens the screener panel (and is mutually exclusive)', () => {
    render(<RightRail />);
    fireEvent.click(screen.getByLabelText('관심종목 패널 토글'));
    fireEvent.click(screen.getByLabelText('스크리너 패널 토글'));
    expect(useRightRailStore.getState().activePanel).toBe('screener');
  });

  it('chevron shows the close affordance and collapses when a panel is open', () => {
    useRightRailStore.setState({ activePanel: 'screener', lastPanel: 'screener' });
    render(<RightRail />);
    const chevron = screen.getByLabelText('우측 패널 닫기');
    expect(chevron).toBeInTheDocument();
    fireEvent.click(chevron);
    expect(useRightRailStore.getState().activePanel).toBeNull();
  });
});
