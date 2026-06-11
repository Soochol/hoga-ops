import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WatchlistRowMenu } from './WatchlistRowMenu';

describe('WatchlistRowMenu (v3, ADR-0069)', () => {
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
});
