import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WatchlistRowMenu, WatchlistMemoRowMenu } from './WatchlistRowMenu';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { addMember, removeFromWatchlist } from '../api/watchlist';
vi.mock('../api/watchlist', async (original) => ({
  ...(await original<typeof import('../api/watchlist')>()),
  getWatchlist: vi.fn(async () => ({ folders: [
    { id: 'f1', name: '관찰', order: 0 }, { id: 'f2', name: '추가 그룹', order: 1 },
  ], entries: [{ code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 }], memos: [] })),
  addMember: vi.fn(async () => undefined),
  removeFromWatchlist: vi.fn(async () => undefined),
}));

function renderStockMenu(props: Partial<React.ComponentProps<typeof WatchlistRowMenu>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>
    <WatchlistRowMenu code="005930" name="삼성전자" x={10} y={20} onClose={vi.fn()} {...props} />
  </QueryClientProvider>);
}

describe('WatchlistRowMenu', () => {
  it('바로 그룹 소속을 표시하고 추가 후 메뉴를 유지한다', async () => {
    const onClose = vi.fn();
    renderStockMenu({ onClose });
    expect(await screen.findByRole('menuitemcheckbox', { name: '관찰' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '추가 그룹' }));
    expect(await screen.findByText('삼성전자 → 추가 그룹 추가됨')).toBeInTheDocument();
    expect(addMember).toHaveBeenCalledWith('f2', '005930', undefined);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('그룹 편집')).not.toBeInTheDocument();
  });
  it('관심 해제는 기존 전체 해제 동작을 유지한다', async () => {
    const onClose = vi.fn();
    renderStockMenu({ onClose });
    fireEvent.click(await screen.findByRole('menuitem', { name: '관심 해제' }));
    await waitFor(() => expect(removeFromWatchlist).toHaveBeenCalledWith('005930'));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('삽입 작업은 관심 해제 위에 유지하며 종목 추가 후 닫힌다', async () => {
    const onAddSymbolAbove = vi.fn();
    const onClose = vi.fn();
    renderStockMenu({ onAddSymbolAbove, onInsertMemoAbove: vi.fn(), onClose });
    await screen.findByRole('menuitem', { name: '관심 해제' });
    expect(screen.getAllByRole('menuitem').map(b => b.textContent)).toEqual(['위에 종목 추가', '위에 빈칸 삽입', '관심 해제']);
    fireEvent.click(screen.getByTestId('watchlist-menu-add-symbol'));
    expect(onAddSymbolAbove).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('삽입 콜백이 없으면 삽입 항목을 숨긴다', () => {
    renderStockMenu();
    expect(screen.queryByText('위에 종목 추가')).toBeNull();
    expect(screen.queryByText('위에 빈칸 삽입')).toBeNull();
  });
});

describe('WatchlistMemoRowMenu (v5, 빈칸 행)', () => {
  const props = {
    x: 0, y: 0, text: '구간',
    onFillWithSymbol: vi.fn(), onInsertMemoAbove: vi.fn(),
    onDelete: vi.fn(), onClose: vi.fn(),
  };

  it('renders the three 빈칸 actions', () => {
    render(<WatchlistMemoRowMenu {...props} />);
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['여기에 종목 넣기', '위에 빈칸 삽입', '빈칸 삭제']);
  });

  it('does not offer 종목 행 항목 (그룹 편집·관심 해제)', () => {
    // 빈칸은 종목이 아니다 — 그룹 멤버십도 관심 해제도 대상이 없다.
    render(<WatchlistMemoRowMenu {...props} />);
    expect(screen.queryByText('그룹 편집')).toBeNull();
    expect(screen.queryByText('관심 해제')).toBeNull();
  });

  it('labels an empty 빈칸 without an empty string in the aria-label', () => {
    render(<WatchlistMemoRowMenu {...props} text="" />);
    expect(screen.getByTestId('watchlist-memo-row-menu').getAttribute('aria-label'))
      .toBe('빈칸 컨텍스트 메뉴');
  });

  it('clicking 여기에 종목 넣기 calls onFillWithSymbol then onClose', () => {
    const onFillWithSymbol = vi.fn();
    const onClose = vi.fn();
    render(<WatchlistMemoRowMenu {...props}
      onFillWithSymbol={onFillWithSymbol} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('watchlist-menu-memo-fill-symbol'));
    expect(onFillWithSymbol).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking 빈칸 삭제 calls onDelete then onClose', () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(<WatchlistMemoRowMenu {...props} onDelete={onDelete} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('watchlist-menu-memo-delete'));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
