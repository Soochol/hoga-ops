import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SettingsModal from './SettingsModal';
import { useTabsStore } from '../state/tabs';

describe('SettingsModal — category filtering', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('차트 category does NOT render indicator-scoped toggles', () => {
    render(<SettingsModal onClose={() => {}} />);
    // Default category = 'chart'. fillStrengthCumulative is category='indicators',
    // so its toggle must not appear here.
    expect(screen.queryByTestId('settings-toggle-fillStrengthCumulative')).toBeNull();
    // Pre-existing chart-scoped toggles still appear.
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
  });
});

describe('SettingsModal', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('renders dialog with the auction-window toggle defaulting to ON', () => {
    render(<SettingsModal onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
    const sw = screen.getByRole('switch', { name: '동시호가 구간 지표 숨김' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('Escape key invokes onClose', () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop click invokes onClose; inner click does not', () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('switch', { name: '동시호가 구간 지표 숨김' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('header ✕ and footer 닫기 both invoke onClose', () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose} />);
    // Both header ✕ (aria-label="닫기") and footer "닫기" share the same
    // accessible name, so `getByRole` would throw on ambiguity. Use
    // `getAllByRole` to retrieve both and click each in turn.
    const closers = screen.getAllByRole('button', { name: '닫기' });
    expect(closers).toHaveLength(2);
    fireEvent.click(closers[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(closers[1]);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('toggle click flips the per-tab flag in the store', () => {
    render(<SettingsModal onClose={vi.fn()} />);
    const sw = screen.getByRole('switch', { name: '동시호가 구간 지표 숨김' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    const swAfter = screen.getByRole('switch', { name: '동시호가 구간 지표 숨김' });
    expect(swAfter.getAttribute('aria-checked')).toBe('false');
    const activeId = useTabsStore.getState().activeTabId;
    expect(useTabsStore.getState().getPrefs(activeId).auctionWindowMask).toBe(false);
  });

  it('defaults to 차트 category on first open and shows the chart toggle', () => {
    render(<SettingsModal onClose={vi.fn()} />);
    const chartBtn = screen.getByRole('button', { name: '차트' });
    expect(chartBtn.getAttribute('aria-pressed')).toBe('true');
    const indicatorsBtn = screen.getByRole('button', { name: '보조지표' });
    expect(indicatorsBtn.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('switch', { name: '동시호가 구간 지표 숨김' })).toBeTruthy();
  });

  it('clicking 보조지표 switches content to IndicatorsSection (MA rows)', () => {
    render(<SettingsModal onClose={vi.fn()} />);
    expect(screen.queryByText('MA 5')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '보조지표' }));
    expect(screen.getByText('MA 5')).toBeTruthy();
    expect(screen.getByText('MA 120')).toBeTruthy();
    // Chart toggle is no longer in the DOM.
    expect(screen.queryByRole('switch', { name: '동시호가 구간 지표 숨김' })).toBeNull();
  });

  it('Volume Profile segment reflects current prefs.volumeProfileMode via aria-pressed', () => {
    render(<SettingsModal onClose={vi.fn()} />);
    const seg = screen.getByTestId('settings-volume-profile-mode');
    expect(within(seg).getByRole('button', { name: '전체' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(seg).getByRole('button', { name: '일별' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('Volume Profile segment click writes per-day to the store and updates aria-pressed', () => {
    render(<SettingsModal onClose={vi.fn()} />);
    const seg = screen.getByTestId('settings-volume-profile-mode');
    fireEvent.click(within(seg).getByRole('button', { name: '일별' }));

    const activeId = useTabsStore.getState().activeTabId;
    expect(useTabsStore.getState().getPrefs(activeId).volumeProfileMode).toBe('per-day');

    const segAfter = screen.getByTestId('settings-volume-profile-mode');
    expect(within(segAfter).getByRole('button', { name: '일별' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(segAfter).getByRole('button', { name: '전체' }).getAttribute('aria-pressed')).toBe('false');
  });
});
