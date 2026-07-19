import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useLiveKeyboard } from './useLiveKeyboard';
import { useRightRailStore } from '../state/rightRail';
import { useLiveLayoutStore } from '../state/liveLayout';

function Harness({
  onNextCode,
  onPrevCode,
  onSelectTimeframeShortcut,
}: {
  onNextCode?: () => void;
  onPrevCode?: () => void;
  onSelectTimeframeShortcut?: (slot: 'minute' | 'D' | 'W' | 'M') => void;
}) {
  useLiveKeyboard({
    onNextCode,
    onPrevCode,
    onSelectTimeframeShortcut,
  });
  return <div data-testid="harness" tabIndex={0} />;
}

function HarnessWithInput({
  onNextCode,
  onSelectTimeframeShortcut,
}: {
  onNextCode?: () => void;
  onSelectTimeframeShortcut?: (slot: 'minute' | 'D' | 'W' | 'M') => void;
}) {
  useLiveKeyboard({ onNextCode, onSelectTimeframeShortcut });
  return <input data-testid="input" />;
}

describe('useLiveKeyboard', () => {
  beforeEach(() => {
    cleanup();
    useRightRailStore.setState({ activePanel: null, lastPanel: 'watchlist' });
    useLiveLayoutStore.setState({ detailPanelCollapsed: false });
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


  it('ignores d when typing in an input or with modifiers', () => {
    const { getByTestId } = render(<HarnessWithInput />);
    fireEvent.keyDown(getByTestId('input'), { key: 'd' });
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    fireEvent.keyDown(window, { key: 'd', altKey: true });
    expect(useLiveLayoutStore.getState().detailPanelCollapsed).toBe(false);
  });

  it('Escape no longer closes the right rail panel', () => {
    render(<Harness />);
    useRightRailStore.setState({ activePanel: 'watchlist' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
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

  it('Shift+1..4 trigger timeframe shortcuts', () => {
    const onSelectTimeframeShortcut = vi.fn();
    render(<Harness onSelectTimeframeShortcut={onSelectTimeframeShortcut} />);

    fireEvent.keyDown(window, { key: '!', code: 'Digit1', shiftKey: true });
    fireEvent.keyDown(window, { key: '@', code: 'Digit2', shiftKey: true });
    fireEvent.keyDown(window, { key: '#', code: 'Digit3', shiftKey: true });
    fireEvent.keyDown(window, { key: '$', code: 'Digit4', shiftKey: true });

    expect(onSelectTimeframeShortcut.mock.calls).toEqual([
      ['minute'],
      ['D'],
      ['W'],
      ['M'],
    ]);
  });

  it('Shift+1 with ! key text still triggers minute shortcut using code Digit1', () => {
    const onSelectTimeframeShortcut = vi.fn();
    render(<Harness onSelectTimeframeShortcut={onSelectTimeframeShortcut} />);

    fireEvent.keyDown(window, { key: '!', code: 'Digit1', shiftKey: true });

    expect(onSelectTimeframeShortcut).toHaveBeenCalledOnce();
    expect(onSelectTimeframeShortcut).toHaveBeenCalledWith('minute');
  });

  it('ignores Shift timeframe shortcuts when focus is in an input', () => {
    const onSelectTimeframeShortcut = vi.fn();
    const { getByTestId } = render(<HarnessWithInput onSelectTimeframeShortcut={onSelectTimeframeShortcut} />);

    fireEvent.keyDown(getByTestId('input'), {
      key: '!',
      code: 'Digit1',
      shiftKey: true,
    });

    expect(onSelectTimeframeShortcut).not.toHaveBeenCalled();
  });

  it('ignores Ctrl/Meta/Alt modified Shift timeframe shortcuts', () => {
    const onSelectTimeframeShortcut = vi.fn();
    render(<Harness onSelectTimeframeShortcut={onSelectTimeframeShortcut} />);

    fireEvent.keyDown(window, { key: '!', code: 'Digit1', shiftKey: true, ctrlKey: true });
    fireEvent.keyDown(window, { key: '!', code: 'Digit1', shiftKey: true, metaKey: true });
    fireEvent.keyDown(window, { key: '!', code: 'Digit1', shiftKey: true, altKey: true });

    expect(onSelectTimeframeShortcut).not.toHaveBeenCalled();
  });

  it('plain digit keys are no-ops now that tab switching is removed', () => {
    const onSelectTimeframeShortcut = vi.fn();
    render(<Harness onSelectTimeframeShortcut={onSelectTimeframeShortcut} />);

    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: '3' });

    // 평범한 숫자는 더 이상 아무 단축키도 트리거하지 않는다(타임프레임은 Shift+숫자만).
    expect(onSelectTimeframeShortcut).not.toHaveBeenCalled();
  });
});
