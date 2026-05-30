import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveSymbolSearch } from './LiveSymbolSearch';
import { useLivePageStore } from '../state/livePage';
import * as watchlistApi from '../api/watchlist';
import type { SymbolHit } from '../api/types';

const HIT: SymbolHit = {
  code: '005930', name: '삼성전자', market: 'KOSPI',
  captured_count: 0,
  captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
};

// Faithful to the real contract: filterSymbols('') returns ALL symbols (not
// []), so the mock returns [HIT] for EVERY query — including the empty one.
// This is what lets the empty-Enter guard test below catch the regression.
vi.mock('../capture/useSymbols', () => ({
  useSymbolSearch: () => [HIT],
}));

function renderSearch() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], { entries: [], next_run_at_ms: 0 });
  return render(
    <QueryClientProvider client={qc}>
      <LiveSymbolSearch />
    </QueryClientProvider>,
  );
}

describe('LiveSymbolSearch', () => {
  beforeEach(() => {
    cleanup();
    useLivePageStore.setState({ activeCode: null });
  });

  it('focuses the input when "/" is pressed', () => {
    renderSearch();
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(input);
  });

  it('selecting a result sets activeCode', () => {
    renderSearch();
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '삼성' } });
    fireEvent.click(screen.getByText('삼성전자'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
  });

  it('clicking a result row heart adds it to the watchlist', async () => {
    const spy = vi.spyOn(watchlistApi, 'addToWatchlist').mockResolvedValue({} as never);
    renderSearch();
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '삼성' } });
    fireEvent.click(screen.getByRole('button', { name: '관심종목 추가' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('005930'));
    spy.mockRestore();
  });

  it('Enter on a focused empty input does not select an arbitrary symbol', () => {
    renderSearch();
    const input = screen.getByRole('combobox');
    fireEvent.focus(input); // opens dropdown logic but query is still ''
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });
});
