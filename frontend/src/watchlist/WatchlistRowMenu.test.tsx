import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WatchlistRowMenu } from './WatchlistRowMenu';

describe('WatchlistRowMenu', () => {
  it('renders a role=menu with the 관심 해제 item', () => {
    render(<WatchlistRowMenu x={10} y={20} name="삼성전자" onRemove={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('watchlist-row-menu').getAttribute('role')).toBe('menu');
    expect(screen.getByText('관심 해제')).toBeInTheDocument();
  });

  it('clicking 관심 해제 calls onRemove then onClose', () => {
    const onRemove = vi.fn();
    const onClose = vi.fn();
    render(<WatchlistRowMenu x={0} y={0} name="삼성전자" onRemove={onRemove} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('watchlist-menu-remove'));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('그룹으로 이동 lists other folders + 미분류 and fires onMove', () => {
    const onMove = vi.fn();
    const onClose = vi.fn();
    render(<WatchlistRowMenu x={0} y={0} name="삼성전자" onRemove={vi.fn()} onClose={onClose}
      folders={[{ id: 'f_a', name: '스윙' }, { id: 'f_b', name: '장기' }]}
      currentFolderId="f_a" onMove={onMove} />);
    // 현재 그룹(스윙)은 빠지고, 장기 + 미분류만 대상
    expect(screen.queryByTestId('watchlist-menu-move-f_a')).toBeNull();
    expect(screen.getByTestId('watchlist-menu-move-uncat')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('watchlist-menu-move-f_b'));
    expect(onMove).toHaveBeenCalledWith('f_b');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('미분류 소속이면 미분류 대상이 빠진다', () => {
    render(<WatchlistRowMenu x={0} y={0} name="삼성전자" onRemove={vi.fn()} onClose={vi.fn()}
      folders={[{ id: 'f_a', name: '스윙' }]} currentFolderId={null} onMove={vi.fn()} />);
    expect(screen.getByTestId('watchlist-menu-move-f_a')).toBeInTheDocument();
    expect(screen.queryByTestId('watchlist-menu-move-uncat')).toBeNull();
  });

  it('onMove 미전달이면 이동 섹션이 렌더되지 않는다', () => {
    render(<WatchlistRowMenu x={0} y={0} name="삼성전자" onRemove={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText('그룹으로 이동')).toBeNull();
  });
});
