import { it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLiveKeyboard } from './useLiveKeyboard';

function press(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }));
}

it('] calls onNextTab, [ calls onPrevTab', () => {
  const onNextTab = vi.fn(), onPrevTab = vi.fn();
  renderHook(() => useLiveKeyboard({ onNextTab, onPrevTab }));
  press(']'); expect(onNextTab).toHaveBeenCalled();
  press('['); expect(onPrevTab).toHaveBeenCalled();
});

it('digit keys call onSelectTabIndex with 0-based index', () => {
  const onSelectTabIndex = vi.fn();
  renderHook(() => useLiveKeyboard({ onSelectTabIndex }));
  press('3'); expect(onSelectTabIndex).toHaveBeenCalledWith(2);
});

it('ignores Ctrl-modified keys (browser-reserved)', () => {
  const onNextTab = vi.fn();
  renderHook(() => useLiveKeyboard({ onNextTab }));
  press(']', { ctrlKey: true }); expect(onNextTab).not.toHaveBeenCalled();
});
