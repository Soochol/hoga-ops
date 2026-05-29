import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { LiveEmptyState } from './LiveEmptyState';

function render_(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe('LiveEmptyState', () => {
  it('renders no_active_code variant', () => {
    render_(<LiveEmptyState cause="no_active_code" />);
    expect(screen.getByText(/관심종목을 선택해주세요/)).toBeInTheDocument();
  });

  it('renders watchlist_empty variant with /capture link', () => {
    render_(<LiveEmptyState cause="watchlist_empty" />);
    expect(screen.getByText(/관심종목이 비어/)).toBeInTheDocument();
    expect(screen.getByText('종목 추가').getAttribute('href')).toBe('/capture');
  });
});
