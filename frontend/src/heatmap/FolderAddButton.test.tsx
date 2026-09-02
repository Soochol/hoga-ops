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

/** 새로 필수가 된 두 prop 의 기본값 — 이 파일의 관심사는 자동 열기·포털·실패 유지이지
 *  중복 판정이 아니다(그건 `FolderAddButton.duplicate.test.tsx` 가 따로 잰다). */
const base = () => ({ isDuplicate: () => false, onDuplicate: vi.fn() });

it('＋종목 → 종목 선택 → 추가 시 addToFolder(code, folderId)', async () => {
  render(<FolderAddButton {...base()} folderId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  fireEvent.click(screen.getByTestId('pick'));
  fireEvent.click(screen.getByRole('button', { name: '추가' }));
  await waitFor(() => expect(addToFolder).toHaveBeenCalledWith('005930', 'f1'));
});

// 새 그룹 직후 페이지가 켜 주는 자동 열기. 갓 만든 그룹은 행이 없어 클릭 표적이
// 이 버튼 하나뿐이라 "만들기 → 종목 넣기"가 한 흐름이어야 한다.
it('autoOpen 이면 클릭 없이 팝오버가 열리고, 닫으면 다시 열리지 않는다', () => {
  const { rerender } = render(<FolderAddButton {...base()} folderId="f1" autoOpen />);
  expect(screen.getByRole('dialog', { name: '종목 추가' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  expect(screen.queryByRole('dialog', { name: '종목 추가' })).toBeNull();
  // 부모 리렌더(폴링 등)로 같은 prop 이 다시 흘러도 되살아나지 않는다 — autoOpen 은
  // 마운트 시 초기값으로만 읽는다.
  rerender(<FolderAddButton {...base()} folderId="f1" autoOpen />);
  expect(screen.queryByRole('dialog', { name: '종목 추가' })).toBeNull();
});

// 소비 통지가 없으면 페이지가 표식을 못 태우고, 검색 필터로 카드가 언마운트→재마운트될 때
// (마운트마다 초기값을 다시 읽으므로) 팝오버가 계속 되살아난다.
it('자동으로 열렸으면 onAutoOpened 로 1회 통지한다', () => {
  const onAutoOpened = vi.fn();
  const { rerender } = render(<FolderAddButton {...base()} folderId="f1" autoOpen onAutoOpened={onAutoOpened} />);
  expect(onAutoOpened).toHaveBeenCalledTimes(1);
  // 페이지가 표식을 태운 뒤(autoOpen=false) 다시 부르지 않는다.
  rerender(<FolderAddButton {...base()} folderId="f1" onAutoOpened={onAutoOpened} />);
  expect(onAutoOpened).toHaveBeenCalledTimes(1);
});

it('autoOpen 없이 마운트되면 닫힌 채로 시작하고 통지도 없다', () => {
  const onAutoOpened = vi.fn();
  render(<FolderAddButton {...base()} folderId="f1" onAutoOpened={onAutoOpened} />);
  expect(screen.queryByRole('dialog', { name: '종목 추가' })).toBeNull();
  expect(onAutoOpened).not.toHaveBeenCalled();
});

it('미선택 시 추가 버튼 비활성', () => {
  render(<FolderAddButton {...base()} folderId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  expect(screen.getByRole('button', { name: '추가' })).toBeDisabled();
});

it('팝오버는 createPortal 로 body 직속 — 카드 overflow-hidden/multicol 클리핑 회피', () => {
  const { container } = render(<FolderAddButton {...base()} folderId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  const dialog = screen.getByRole('dialog', { name: '종목 추가' });
  // 포털 대상이 document.body 라 폴더 카드의 overflow-hidden 경계 밖에 산다(클리핑 회피).
  expect(dialog.parentElement).toBe(document.body);
  // 트리거가 사는 컴포넌트 서브트리(실사용 시 overflow-hidden 카드 안)엔 팝오버가 없다.
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('addToFolder 실패 시 unhandled rejection 없이 팝오버 유지(재시도 가능)', async () => {
  addToFolder.mockRejectedValueOnce(new Error('boom'));
  render(<FolderAddButton {...base()} folderId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  fireEvent.click(screen.getByTestId('pick'));
  fireEvent.click(screen.getByRole('button', { name: '추가' }));
  await waitFor(() => expect(addToFolder).toHaveBeenCalledWith('005930', 'f1'));
  // 실패 후에도 팝오버(추가 버튼)가 닫히지 않고 남아 재시도 가능.
  expect(screen.getByRole('button', { name: '추가' })).toBeInTheDocument();
});
