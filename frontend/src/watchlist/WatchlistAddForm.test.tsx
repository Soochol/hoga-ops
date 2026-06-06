import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WatchlistAddForm } from './WatchlistAddForm';

vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: { onChange: (h: any) => void }) => (
    <button onClick={() => onChange({ code: '005930', name: '삼성전자' })}>pick</button>
  ),
}));

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('WatchlistAddForm', () => {
  beforeEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('adds the picked code and fires onAdded', async () => {
    const add = vi.spyOn(api, 'addToWatchlist').mockResolvedValue({
      code: '005930', name: '삼성전자', registered_at_kst_date: '20260101',
      last_success_date: null, folder_id: null, order: 0 });
    const onAdded = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistAddForm onAdded={onAdded} />, { wrapper: wrap(qc) });
    fireEvent.click(screen.getByText('pick'));
    fireEvent.click(screen.getByRole('button', { name: /추가/ }));
    await waitFor(() => expect(add).toHaveBeenCalledWith('005930'));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ code: '005930', name: '삼성전자' }));
  });
});
