import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { LiveEmptyState } from './LiveEmptyState';

function render_(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe('LiveEmptyState', () => {
  it('renders no_active_code variant', () => {
    render_(<LiveEmptyState cause="no_active_code" />);
    expect(screen.getByText(/검색하세요/)).toBeInTheDocument();
  });

  it('opens search when the no_active_code slash button is clicked', () => {
    const onOpenSearch = vi.fn();
    render_(<LiveEmptyState cause="no_active_code" onOpenSearch={onOpenSearch} />);
    fireEvent.click(screen.getByRole('button', { name: '종목 검색 열기' }));
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it('renders watchlist_empty variant with /capture link', () => {
    render_(<LiveEmptyState cause="watchlist_empty" />);
    expect(screen.getByText(/관심종목이 비어/)).toBeInTheDocument();
    expect(screen.getByText('종목 추가').getAttribute('href')).toBe('/capture');
  });
});
