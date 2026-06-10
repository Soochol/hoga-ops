import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { it, expect, vi, beforeEach } from 'vitest';

vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: { onChange: (h: { code: string; name: string; market: string }) => void }) =>
    <button data-testid="pick" onClick={() => onChange({ code: '005930', name: '삼성전자', market: 'KOSPI' })}>pick</button>,
}));

const { addToFolder } = vi.hoisted(() => ({ addToFolder: vi.fn(() => Promise.resolve()) }));
vi.mock('./useAddToFolder', () => ({
  useAddToFolder: () => ({ addToFolder, isPending: false, error: null }),
}));

import { FolderAddButton } from './FolderAddButton';

beforeEach(() => { addToFolder.mockClear(); });

it('＋종목 → 종목 선택 → 추가 시 addToFolder(code, folderId)', async () => {
  render(<FolderAddButton folderId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  fireEvent.click(screen.getByTestId('pick'));
  fireEvent.click(screen.getByRole('button', { name: '추가' }));
  await waitFor(() => expect(addToFolder).toHaveBeenCalledWith('005930', 'f1'));
});

it('미선택 시 추가 버튼 비활성', () => {
  render(<FolderAddButton folderId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  expect(screen.getByRole('button', { name: '추가' })).toBeDisabled();
});

it('addToFolder 실패 시 unhandled rejection 없이 팝오버 유지(재시도 가능)', async () => {
  addToFolder.mockRejectedValueOnce(new Error('boom'));
  render(<FolderAddButton folderId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  fireEvent.click(screen.getByTestId('pick'));
  fireEvent.click(screen.getByRole('button', { name: '추가' }));
  await waitFor(() => expect(addToFolder).toHaveBeenCalledWith('005930', 'f1'));
  // 실패 후에도 팝오버(추가 버튼)가 닫히지 않고 남아 재시도 가능.
  expect(screen.getByRole('button', { name: '추가' })).toBeInTheDocument();
});
