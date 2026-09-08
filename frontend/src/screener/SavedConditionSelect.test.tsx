import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { SavedConditionSelect } from './SavedConditionSelect';

const saves = [{ id: 'a', name: '신고가, 거래대금' }, { id: 'b', name: '4일 신고가' }];
it('keeps the portal open across mouse events, input and refreshed props, then selects once', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const { rerender } = render(<SavedConditionSelect saves={saves} selectedId="a" onSelect={onSelect} />);
  await user.click(screen.getByRole('button', { name: '저장한 조건검색 선택' }));
  const input = screen.getByRole('combobox', { name: '조건검색 이름 검색' });
  await user.click(input);
  await user.type(input, '4일');
  rerender(<SavedConditionSelect saves={saves.map((s) => ({ ...s }))} selectedId="a" onSelect={onSelect} />);
  expect(screen.getByRole('listbox')).toBeVisible();
  expect(input).toHaveValue('4일');
  await user.click(screen.getByRole('option', { name: '4일 신고가' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('b');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '저장한 조건검색 선택' })).toHaveFocus();
});
it('supports arrows, Enter, Escape, empty search and outside dismissal without selecting', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<><SavedConditionSelect saves={saves} selectedId="a" onSelect={onSelect} /><button>바깥</button></>);
  screen.getByRole('button', { name: '저장한 조건검색 선택' }).focus();
  await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('b');
  await user.click(screen.getByRole('button', { name: '저장한 조건검색 선택' }));
  await user.type(screen.getByRole('combobox'), '없는이름');
  expect(screen.getByText('검색 결과가 없습니다')).toBeVisible();
  await user.keyboard('{Enter}{Escape}');
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '저장한 조건검색 선택' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: '저장한 조건검색 선택' }));
  await user.click(screen.getByText('바깥'));
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});
it('does not reload a selected save or offer draft creation as an option', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<SavedConditionSelect saves={saves} selectedId="a" onSelect={onSelect} />);
  await user.click(screen.getByRole('button', { name: '저장한 조건검색 선택' }));
  expect(screen.queryByRole('option', { name: '새 조건검색' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('option', { name: '신고가, 거래대금' }));
  expect(onSelect).not.toHaveBeenCalled();
});
it('closes on keyboard focus leaving the popup', async () => {
  const user = userEvent.setup();
  render(<SavedConditionSelect saves={saves} selectedId="a" onSelect={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: '저장한 조건검색 선택' }));
  fireEvent.blur(screen.getByRole('combobox'), { relatedTarget: document.body });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});
