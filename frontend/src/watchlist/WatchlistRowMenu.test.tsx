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
});
