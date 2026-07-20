import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useLiveKeyboard } from './useLiveKeyboard';
import { useRightRailStore } from '../state/rightRail';
import { useLiveLayoutStore } from '../state/liveLayout';

function Harness({
  onNextCode,
  onPrevCode,
  onSelectTimeframeShortcut,
  onAddChartWindow,
  onTidy,
  onCycleFocus,
}: {
  onNextCode?: () => void;
  onPrevCode?: () => void;
  onSelectTimeframeShortcut?: (slot: 'minute' | 'D' | 'W' | 'M') => void;
  onAddChartWindow?: () => void;
  onTidy?: () => void;
  onCycleFocus?: (dir: 1 | -1) => void;
}) {
  useLiveKeyboard({
    onNextCode,
    onPrevCode,
    onSelectTimeframeShortcut,
    onAddChartWindow,
    onTidy,
    onCycleFocus,
  });
  return <div data-testid="harness" tabIndex={0} />;
}

function HarnessWithInput({
  onNextCode,
  onSelectTimeframeShortcut,
  onAddChartWindow,
  onTidy,
  onCycleFocus,
}: {
  onNextCode?: () => void;
  onSelectTimeframeShortcut?: (slot: 'minute' | 'D' | 'W' | 'M') => void;
  onAddChartWindow?: () => void;
  onTidy?: () => void;
  onCycleFocus?: (dir: 1 | -1) => void;
}) {
  useLiveKeyboard({ onNextCode, onSelectTimeframeShortcut, onAddChartWindow, onTidy, onCycleFocus });
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

  describe('창 관리 단축키 (ADR-0119 PR-E)', () => {
    it('n triggers onAddChartWindow', () => {
      const add = vi.fn();
      render(<Harness onAddChartWindow={add} />);
      fireEvent.keyDown(window, { key: 'n' });
      expect(add).toHaveBeenCalledOnce();
    });

    it('t triggers onTidy', () => {
      const tidy = vi.fn();
      render(<Harness onTidy={tidy} />);
      fireEvent.keyDown(window, { key: 't' });
      expect(tidy).toHaveBeenCalledOnce();
    });

    it('] cycles focus forward, [ backward', () => {
      const cycle = vi.fn();
      render(<Harness onCycleFocus={cycle} />);
      fireEvent.keyDown(window, { key: ']' });
      fireEvent.keyDown(window, { key: '[' });
      expect(cycle).toHaveBeenNthCalledWith(1, 1);
      expect(cycle).toHaveBeenNthCalledWith(2, -1);
    });

    it('창 관리 키는 입력 필드에선 억제된다', () => {
      const add = vi.fn(); const tidy = vi.fn(); const cycle = vi.fn();
      const { getByTestId } = render(
        <HarnessWithInput onAddChartWindow={add} onTidy={tidy} onCycleFocus={cycle} />,
      );
      const input = getByTestId('input');
      fireEvent.keyDown(input, { key: 'n' });
      fireEvent.keyDown(input, { key: 't' });
      fireEvent.keyDown(input, { key: ']' });
      expect(add).not.toHaveBeenCalled();
      expect(tidy).not.toHaveBeenCalled();
      expect(cycle).not.toHaveBeenCalled();
    });

    it('Alt 조합(드로잉 도구 단축키)에선 창 관리 키가 발화하지 않는다', () => {
      const tidy = vi.fn();
      render(<Harness onTidy={tidy} />);
      // 드로잉 도구는 Alt+t — useLiveKeyboard 는 altKey early-return 이라 무충돌.
      fireEvent.keyDown(window, { key: 't', altKey: true });
      expect(tidy).not.toHaveBeenCalled();
    });
  });
});
