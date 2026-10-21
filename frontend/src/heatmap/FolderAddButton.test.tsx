import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { it, expect, vi, beforeEach } from 'vitest';
import type { SymbolSearchProps } from '../capture/SymbolSearch';

const hit = { code: '005930', name: '삼성전자', market: 'KOSPI' as const, captured_count: 0,
  captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } };
vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange, disabled, optionState }: SymbolSearchProps) => <>
    <input aria-label="검색" disabled={disabled} onChange={() => onChange(null)} />
    <button data-testid="pick" disabled={disabled || optionState?.(hit) === 'added'}
      onClick={() => onChange(hit)}>{optionState?.(hit) === 'added' ? '추가됨' : 'pick'}</button>
  </>,
}));
const { addToFolder, removeFromFolder } = vi.hoisted(() => ({
  addToFolder: vi.fn<() => Promise<void>>(), removeFromFolder: vi.fn<() => Promise<void>>(),
}));
vi.mock('./useAddToFolder', () => ({
  useAddToFolder: () => ({ addToFolder, removeFromFolder }),
}));
import { FolderAddButton } from './FolderAddButton';

beforeEach(() => {
  addToFolder.mockReset().mockResolvedValue();
  removeFromFolder.mockReset().mockResolvedValue();
});
const base = () => ({ folderId: 'f1', isDuplicate: () => false, onDuplicate: vi.fn() });
const openAndPick = () => {
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  fireEvent.click(screen.getByTestId('pick'));
};

it('선택 즉시 추가하고 팝오버와 입력 포커스를 유지하며 별도 추가 버튼은 없다', async () => {
  render(<FolderAddButton {...base()} />);
  openAndPick();
  await waitFor(() => expect(addToFolder).toHaveBeenCalledWith('005930', 'f1'));
  expect(await screen.findByLabelText('종목 추가 안내')).toHaveTextContent('삼성전자 추가됨');
  expect(screen.getByRole('dialog', { name: '종목 추가' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '추가' })).not.toBeInTheDocument();
});

it('진행 중에는 검색·선택과 중복 전송을 막고 완료 후 검색으로 포커스를 돌린다', async () => {
  let release!: () => void;
  addToFolder.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
  render(<FolderAddButton {...base()} />);
  openAndPick();
  expect(screen.getByRole('textbox', { name: '검색' })).toBeDisabled();
  fireEvent.click(screen.getByTestId('pick'));
  expect(addToFolder).toHaveBeenCalledOnce();
  await act(async () => release());
  expect(screen.getByRole('textbox', { name: '검색' })).toHaveFocus();
  expect(screen.getByTestId('pick')).toBeEnabled();
});

it('이미 등록된 결과는 추가됨으로 표시하고 재전송하지 않는다', () => {
  render(<FolderAddButton {...base()} isDuplicate={() => true} />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  expect(screen.getByTestId('pick')).toHaveTextContent('추가됨');
  expect(screen.getByTestId('pick')).toBeDisabled();
  fireEvent.click(screen.getByTestId('pick'));
  expect(addToFolder).not.toHaveBeenCalled();
});

it('실행 취소는 마지막 추가의 현재 그룹만 해제하고 검색창을 유지한다', async () => {
  render(<FolderAddButton {...base()} />);
  openAndPick();
  fireEvent.click(await screen.findByRole('button', { name: '실행 취소' }));
  await waitFor(() => expect(removeFromFolder).toHaveBeenCalledWith('005930', 'f1'));
  expect(await screen.findByLabelText('종목 추가 안내')).toHaveTextContent('삼성전자 추가 취소됨');
  expect(screen.queryByRole('button', { name: '실행 취소' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '검색' })).toHaveFocus();
});

it('추가 실패 사유와 다시 시도를 표시하고 재시도 성공 후에도 검색창을 유지한다', async () => {
  addToFolder.mockRejectedValueOnce(new Error('저장 실패'));
  render(<FolderAddButton {...base()} />);
  openAndPick();
  expect(await screen.findByRole('alert')).toHaveTextContent('종목을 추가하지 못했습니다. 저장 실패');
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(await screen.findByLabelText('종목 추가 안내')).toHaveTextContent('삼성전자 추가됨');
  expect(addToFolder).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: '종목 추가' })).toBeVisible();
});

it('취소 실패도 사유를 표시하고 다시 시도는 추가가 아닌 취소를 반복한다', async () => {
  removeFromFolder.mockRejectedValueOnce(new Error('취소 실패'));
  render(<FolderAddButton {...base()} />);
  openAndPick();
  fireEvent.click(await screen.findByRole('button', { name: '실행 취소' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('추가를 취소하지 못했습니다. 취소 실패');
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await waitFor(() => expect(removeFromFolder).toHaveBeenCalledTimes(2));
  expect(addToFolder).toHaveBeenCalledOnce();
});

it.each(['다시 검색', '닫고 열기'])('실패 안내는 %s에서 해제한다', async action => {
  addToFolder.mockRejectedValueOnce(null);
  render(<FolderAddButton {...base()} />);
  openAndPick();
  expect(await screen.findByRole('alert')).toHaveTextContent('잠시 후 다시 시도하세요.');
  if (action === '다시 검색') fireEvent.change(screen.getByRole('textbox', { name: '검색' }), { target: { value: '다른 종목' } });
  else {
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  }
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('autoOpen은 한 번만 열고 닫은 뒤 다시 열리지 않는다', () => {
  const onAutoOpened = vi.fn();
  const props = { ...base(), autoOpen: true, onAutoOpened };
  const { rerender } = render(<FolderAddButton {...props} />);
  expect(screen.getByRole('dialog', { name: '종목 추가' })).toBeInTheDocument();
  expect(onAutoOpened).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  rerender(<FolderAddButton {...props} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('팝오버는 카드 클리핑을 피하도록 body에 렌더하고 Escape는 트리거로 복귀한다', () => {
  const { container } = render(<FolderAddButton {...base()} />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  expect(screen.getByRole('dialog').parentElement).toBe(document.body);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '종목 추가' })).toHaveFocus();
});
