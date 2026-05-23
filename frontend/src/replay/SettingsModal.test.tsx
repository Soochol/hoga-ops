import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SettingsModal from './SettingsModal';
import { useTabsStore } from '../state/tabs';

describe('SettingsModal', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('renders dialog with the auction-window toggle defaulting to ON', () => {
    render(<SettingsModal onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
    const sw = screen.getByRole('switch', { name: '호가비 동시호가 마스킹' });
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
    fireEvent.click(screen.getByRole('switch', { name: '호가비 동시호가 마스킹' }));
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
    const sw = screen.getByRole('switch', { name: '호가비 동시호가 마스킹' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    const swAfter = screen.getByRole('switch', { name: '호가비 동시호가 마스킹' });
    expect(swAfter.getAttribute('aria-checked')).toBe('false');
    const activeId = useTabsStore.getState().activeTabId;
    expect(useTabsStore.getState().getPrefs(activeId).auctionWindowMask).toBe(false);
  });
});
