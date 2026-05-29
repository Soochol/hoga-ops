import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useLiveKeyboard } from './useLiveKeyboard';
import { useLivePageStore } from '../state/livePage';
import { useRightRailStore } from '../state/rightRail';

function Harness({ onNextCode, onPrevCode }: { onNextCode?: () => void; onPrevCode?: () => void }) {
  useLiveKeyboard({ onNextCode, onPrevCode });
  return <div data-testid="harness" tabIndex={0} />;
}

function HarnessWithInput({ onNextCode }: { onNextCode?: () => void }) {
  useLiveKeyboard({ onNextCode });
  return <input data-testid="input" />;
}

describe('useLiveKeyboard', () => {
  beforeEach(() => {
    cleanup();
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
    });
    useRightRailStore.setState({ panelOpen: false, railCollapsed: false });
  });

  it('j triggers onNextCode', () => {
    const next = vi.fn();
    render(<Harness onNextCode={next} />);
    fireEvent.keyDown(window, { key: 'j' });
    expect(next).toHaveBeenCalledOnce();
  });

  it('k triggers onPrevCode', () => {
    const prev = vi.fn();
    render(<Harness onPrevCode={prev} />);
    fireEvent.keyDown(window, { key: 'k' });
    expect(prev).toHaveBeenCalledOnce();
  });

  it('w toggles watchlist panel', () => {
    render(<Harness />);
    expect(useRightRailStore.getState().panelOpen).toBe(false);
    fireEvent.keyDown(window, { key: 'w' });
    expect(useRightRailStore.getState().panelOpen).toBe(true);
    fireEvent.keyDown(window, { key: 'w' });
    expect(useRightRailStore.getState().panelOpen).toBe(false);
  });

  it('Escape closes panel only when open', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRightRailStore.getState().panelOpen).toBe(false);

    useRightRailStore.setState({ panelOpen: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRightRailStore.getState().panelOpen).toBe(false);
  });

  it('ignores shortcuts when focus is in an input', () => {
    const next = vi.fn();
    const { getByTestId } = render(<HarnessWithInput onNextCode={next} />);
    const input = getByTestId('input');
    fireEvent.keyDown(input, { key: 'j' });
    expect(next).not.toHaveBeenCalled();
  });

  it('ignores shortcuts with modifier keys', () => {
    const next = vi.fn();
    render(<Harness onNextCode={next} />);
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(next).not.toHaveBeenCalled();
  });
});
