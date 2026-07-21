import { it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { requestWorkspaceTidy } from '../workspace/workspaceCanvasControls';
import { useStudyKeyboard } from './useStudyKeyboard';

vi.mock('../workspace/workspaceCanvasControls', () => ({
  requestWorkspaceTidy: vi.fn(),
}));

function Harness({
  onSelectTabIndex,
  onNextTab,
  onPrevTab,
}: {
  onSelectTabIndex?: (index: number) => void;
  onNextTab?: () => void;
  onPrevTab?: () => void;
}) {
  useStudyKeyboard({ onSelectTabIndex, onNextTab, onPrevTab });
  return <input data-testid="input" />;
}

it('selects tabs 1-4 by digit keys', () => {
  const onSelectTabIndex = vi.fn();
  render(<Harness onSelectTabIndex={onSelectTabIndex} />);
  fireEvent.keyDown(window, { key: '1' });
  fireEvent.keyDown(window, { key: '4' });
  expect(onSelectTabIndex).toHaveBeenNthCalledWith(1, 0);
  expect(onSelectTabIndex).toHaveBeenNthCalledWith(2, 3);
});

it('cycles tabs with ] (next) and [ (prev)', () => {
  const onNextTab = vi.fn();
  const onPrevTab = vi.fn();
  render(<Harness onNextTab={onNextTab} onPrevTab={onPrevTab} />);
  fireEvent.keyDown(window, { key: ']' });
  expect(onNextTab).toHaveBeenCalledTimes(1);
  expect(onPrevTab).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: '[' });
  expect(onPrevTab).toHaveBeenCalledTimes(1);
});

it('t 는 창 정리(Tidy)를 요청한다', () => {
  render(<Harness />);
  fireEvent.keyDown(window, { key: 't' });
  expect(requestWorkspaceTidy).toHaveBeenCalledTimes(1);
});

it('suppresses tab cycling while typing or with modifiers', () => {
  const onNextTab = vi.fn();
  const onPrevTab = vi.fn();
  const { getByTestId } = render(<Harness onNextTab={onNextTab} onPrevTab={onPrevTab} />);
  fireEvent.keyDown(getByTestId('input'), { key: ']' });
  fireEvent.keyDown(window, { key: ']', ctrlKey: true });
  fireEvent.keyDown(window, { key: '[', metaKey: true });
  fireEvent.keyDown(window, { key: '[', altKey: true });
  expect(onNextTab).not.toHaveBeenCalled();
  expect(onPrevTab).not.toHaveBeenCalled();
});
