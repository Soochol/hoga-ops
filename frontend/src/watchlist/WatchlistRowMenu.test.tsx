import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WatchlistRowMenu, WatchlistMemoRowMenu } from './WatchlistRowMenu';

describe('WatchlistRowMenu (v3, ADR-0070)', () => {
  it('renders 그룹 편집 + 관심 해제 (no legacy 그룹으로 이동)', () => {
    render(<WatchlistRowMenu x={10} y={20} name="삼성전자"
      onEditGroups={vi.fn()} onRemove={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('watchlist-row-menu').getAttribute('role')).toBe('menu');
    expect(screen.getByText('그룹 편집')).toBeInTheDocument();
    expect(screen.getByText('관심 해제')).toBeInTheDocument();
    expect(screen.queryByText('그룹으로 이동')).toBeNull();
  });

  it('clicking 그룹 편집 calls onEditGroups then onClose', () => {
    const onEditGroups = vi.fn();
    const onClose = vi.fn();
    render(<WatchlistRowMenu x={0} y={0} name="삼성전자"
      onEditGroups={onEditGroups} onRemove={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('watchlist-menu-edit-groups'));
    expect(onEditGroups).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking 관심 해제 calls onRemove then onClose', () => {
    const onRemove = vi.fn();
    const onClose = vi.fn();
    render(<WatchlistRowMenu x={0} y={0} name="삼성전자"
      onEditGroups={vi.fn()} onRemove={onRemove} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('watchlist-menu-remove'));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('hides 삽입 항목 when the callbacks are not passed (미분류·등락률 정렬 그룹)', () => {
    render(<WatchlistRowMenu x={0} y={0} name="삼성전자"
      onEditGroups={vi.fn()} onRemove={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText('위에 종목 추가')).toBeNull();
    expect(screen.queryByText('위에 빈칸 삽입')).toBeNull();
  });

  it('clicking 위에 종목 추가 calls onAddSymbolAbove then onClose', () => {
    const onAddSymbolAbove = vi.fn();
    const onClose = vi.fn();
    render(<WatchlistRowMenu x={0} y={0} name="삼성전자"
      onEditGroups={vi.fn()} onRemove={vi.fn()}
      onAddSymbolAbove={onAddSymbolAbove} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('watchlist-menu-add-symbol'));
    expect(onAddSymbolAbove).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('puts 관심 해제 last so the destructive item is farthest from the cursor', () => {
    render(<WatchlistRowMenu x={0} y={0} name="삼성전자"
      onEditGroups={vi.fn()} onRemove={vi.fn()}
      onAddSymbolAbove={vi.fn()} onInsertMemoAbove={vi.fn()} onClose={vi.fn()} />);
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['그룹 편집', '위에 종목 추가', '위에 빈칸 삽입', '관심 해제']);
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
