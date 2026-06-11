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

it('팝오버는 createPortal 로 body 직속 — 카드 overflow-hidden/multicol 클리핑 회피', () => {
  const { container } = render(<FolderAddButton folderId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  const dialog = screen.getByRole('dialog', { name: '종목 추가' });
  // 포털 대상이 document.body 라 폴더 카드의 overflow-hidden 경계 밖에 산다(클리핑 회피).
  expect(dialog.parentElement).toBe(document.body);
  // 트리거가 사는 컴포넌트 서브트리(실사용 시 overflow-hidden 카드 안)엔 팝오버가 없다.
  expect(container.querySelector('[role="dialog"]')).toBeNull();
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
