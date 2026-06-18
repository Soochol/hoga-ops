import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { StudyMemoPanel } from './StudyMemoPanel';

beforeEach(() => {
  localStorage.clear();
});

it('commits trimmed memo edits with the save button', async () => {
  const onCommit = vi.fn();
  render(<StudyMemoPanel memo="old" isSaving={false} errorMessage={null} onClose={vi.fn()} onCommit={onCommit} />);
  const memo = screen.getByLabelText('저장뷰 메모') as HTMLTextAreaElement;
  await userEvent.clear(memo);
  await userEvent.type(memo, ' 새 메모 ');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));

  expect(onCommit).toHaveBeenCalledWith('새 메모');
  expect(onCommit).toHaveBeenCalledTimes(1);
});

it('cancels the draft and closes on Escape', async () => {
  const onClose = vi.fn();
  const onCommit = vi.fn();
  render(<StudyMemoPanel memo="old" isSaving={false} errorMessage={null} onClose={onClose} onCommit={onCommit} />);
  const memo = screen.getByLabelText('저장뷰 메모') as HTMLTextAreaElement;
  await userEvent.clear(memo);
  await userEvent.type(memo, 'draft');
  await userEvent.keyboard('{Escape}');

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onCommit).not.toHaveBeenCalled();
});

it('renders save errors inline', () => {
  render(<StudyMemoPanel memo="" isSaving={false} errorMessage="메모 저장 실패" onClose={vi.fn()} onCommit={vi.fn()} />);

  expect(screen.getByText('메모 저장 실패')).toBeTruthy();
});

it('persists resized memo panel height', () => {
  render(<StudyMemoPanel memo="" isSaving={false} errorMessage={null} onClose={vi.fn()} onCommit={vi.fn()} />);

  const panel = screen.getByTestId('study-memo-panel');
  const handle = screen.getByRole('separator', { name: '메모 크기 조절' });

  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 200 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 280 });
  fireEvent.pointerUp(handle, { pointerId: 1 });

  expect(Number(localStorage.getItem('study.memoPanel.height.v1'))).toBeGreaterThan(280);
  expect(panel).toHaveStyle({ height: `${localStorage.getItem('study.memoPanel.height.v1')}px` });
});

it('resizes the panel with keyboard arrows and persists the height', async () => {
  render(<StudyMemoPanel memo="" isSaving={false} errorMessage={null} onClose={vi.fn()} onCommit={vi.fn()} />);

  const panel = screen.getByTestId('study-memo-panel');
  const handle = screen.getByRole('separator', { name: '메모 크기 조절' });

  handle.focus();
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');

  expect(localStorage.getItem('study.memoPanel.height.v1')).toBe('236');
  expect(panel).toHaveStyle({ height: '236px' });
});
