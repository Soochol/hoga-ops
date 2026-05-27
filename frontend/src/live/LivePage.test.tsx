import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LivePage } from './LivePage';
import { useLivePageStore } from '../state/livePage';

function renderWithRouter(initial = '/live') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/live" element={<LivePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LivePage shell', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      watchlistPanelOpen: false,
    });
  });

  it('renders the four rows of the grid', () => {
    renderWithRouter();
    expect(screen.getByTestId('live-header')).toBeInTheDocument();
    expect(screen.getByTestId('live-status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('live-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('live-workarea')).toBeInTheDocument();
  });

  it('reads activeCode from ?code= query param', () => {
    renderWithRouter('/live?code=000660');
    // The status bar surfaces the code somewhere visible
    expect(screen.getByTestId('live-status-bar').textContent).toContain('000660');
  });

  it('falls back to localStorage activeCode when no query param', () => {
    useLivePageStore.setState({ activeCode: '035720' } as any);
    renderWithRouter();
    expect(screen.getByTestId('live-status-bar').textContent).toContain('035720');
  });

  it('shows empty-state placeholder when no activeCode anywhere', () => {
    renderWithRouter();
    // Empty state placeholder in workarea
    expect(screen.getByTestId('live-workarea').textContent).toMatch(/관심종목/);
  });
});
