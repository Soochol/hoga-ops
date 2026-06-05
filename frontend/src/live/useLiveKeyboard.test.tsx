import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useLiveKeyboard } from './useLiveKeyboard';
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
    useRightRailStore.setState({ activePanel: null, lastPanel: 'watchlist' });
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
    expect(useRightRailStore.getState().activePanel).toBeNull();
    fireEvent.keyDown(window, { key: 'w' });
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
    fireEvent.keyDown(window, { key: 'w' });
    expect(useRightRailStore.getState().activePanel).toBeNull();
  });

  it('Escape closes panel only when open', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRightRailStore.getState().activePanel).toBeNull();

    useRightRailStore.setState({ activePanel: 'watchlist' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRightRailStore.getState().activePanel).toBeNull();
  });

  it('Escape leaves the panel open while a dialog or menu is open', () => {
    render(<Harness />);
    useRightRailStore.setState({ activePanel: 'watchlist' });

    // 열린 모달(role=dialog)이 Escape를 소유 — 패널은 유지된다
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
    dialog.remove();

    // 열린 팝오버(role=menu)도 동일
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
    menu.remove();

    // 둘 다 닫힌 뒤의 Escape만 패널을 닫는다
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRightRailStore.getState().activePanel).toBeNull();
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
