import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  it('renders saved views as the third rail item', () => {
    render(<RightRail />);
    expect(screen.getByRole('button', { name: '저장뷰 패널 토글' })).toBeTruthy();
  });

  it('renders alerts below saved views and toggles the signal alerts panel', () => {
    render(<RightRail />);
    const buttons = screen.getAllByRole('button');
    const savedViewsButton = screen.getByRole('button', { name: '저장뷰 패널 토글' });
    const alertsButton = screen.getByRole('button', { name: '시그널 알림 패널 토글' });

    expect(buttons.indexOf(alertsButton)).toBeGreaterThan(buttons.indexOf(savedViewsButton));
    expect(alertsButton).toHaveAttribute('aria-controls', 'right-rail-signal-alerts-panel');

    fireEvent.click(alertsButton);

    expect(useRightRailStore.getState().activePanel).toBe('signalAlerts');
  });

  it('accepts savedViews from persisted right rail state', async () => {
    localStorage.setItem('rightRail.layout', JSON.stringify({ activePanel: 'savedViews' }));
    vi.resetModules();
    const mod = await import('../state/rightRail');
    expect(mod.useRightRailStore.getState().activePanel).toBe('savedViews');
  });

  it('관심 item opens the watchlist panel', () => {
    render(<RightRail />);
    const btn = screen.getByLabelText('관심종목 패널 토글');
    expect(btn).toHaveClass('text-fg-dim');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
    expect(btn).toHaveClass('bg-tint-selection');
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

  it('chevron reopens the last panel after collapsing', () => {
    useRightRailStore.setState({ activePanel: 'screener', lastPanel: 'screener' });
    render(<RightRail />);
    fireEvent.click(screen.getByLabelText('우측 패널 닫기')); // collapse
    expect(useRightRailStore.getState().activePanel).toBeNull();
    fireEvent.click(screen.getByLabelText('우측 패널 열기')); // reopen lastPanel
    expect(useRightRailStore.getState().activePanel).toBe('screener');
  });
});
