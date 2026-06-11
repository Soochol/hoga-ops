import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WatchlistEntryPane } from './WatchlistEntryPane';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const DATA = {
  folders: [{ id: 'f_a', name: '스윙', order: 0 }],
  entries: [
    { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: '20260102', folder_id: 'f_a', order: 0 },
    { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
  ],
  next_run_at_ms: 0,
};

describe('WatchlistEntryPane', () => {
  beforeEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows only the selected folder entries (미분류)', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected={null} />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    expect(screen.queryByText('삼성전자')).not.toBeInTheDocument();
  });

  it('bulk-deletes checked rows', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const rm = vi.spyOn(api, 'removeEntries').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('005930 선택'));
    fireEvent.click(screen.getByRole('button', { name: /삭제/ }));
    await waitFor(() => expect(rm).toHaveBeenCalledWith(['005930']));
  });

  it('multi-select move sends codes in VISUAL order, not checkbox-click order', async () => {
    // both in 스윙(f_a): 005930 (order 0) before 000660 (order 1) → visual order 005930, 000660.
    // moving to 장기(f_b) exercises the cross-folder case the 모든 종목 view used to cover.
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }, { id: 'f_b', name: '장기', order: 1 }],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 1 },
      ],
      next_run_at_ms: 0,
    });
    // v3 이동 = 대상 추가 후 출처 제거(멤버십). add/remove를 각각 스파이.
    const add = vi.spyOn(api, 'addMember').mockResolvedValue({} as never);
    const rm = vi.spyOn(api, 'removeMember').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    // check in REVERSE visual order: 000660 (2nd row) then 005930 (1st row)
    fireEvent.click(screen.getByLabelText('000660 선택'));
    fireEvent.click(screen.getByLabelText('005930 선택'));
    fireEvent.click(screen.getByRole('button', { name: /이동/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '장기' }));
    // visual order is 005930 before 000660 → add/remove codes must follow that order,
    // add into the target(f_b), remove from the source(f_a).
    await waitFor(() => expect(add.mock.calls.map((c) => c[1])).toEqual(['005930', '000660']));
    expect(add.mock.calls.every((c) => c[0] === 'f_b')).toBe(true);
    expect(rm.mock.calls.map((c) => c[1])).toEqual(['005930', '000660']);
    expect(rm.mock.calls.every((c) => c[0] === 'f_a')).toBe(true);
  });

  it('clears the multi-select when the viewed folder changes', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }, { id: 'f_b', name: '장기', order: 1 }],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
      ],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('005930 선택'));
    expect(screen.getByLabelText('005930 선택')).toHaveAttribute('aria-checked', 'true');
    rerender(<WatchlistEntryPane selected="f_b" />);   // switch away …
    rerender(<WatchlistEntryPane selected="f_a" />);   // … and back: the selection must have cleared
    await waitFor(() =>
      expect(screen.getByLabelText('005930 선택')).toHaveAttribute('aria-checked', 'false'));
  });

  it('move-menu dismisses on outside mousedown and on Escape', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected={null} />, { wrapper: wrap(qc) });
    await screen.findByText('SK하이닉스');
    fireEvent.click(screen.getByLabelText('000660 선택'));

    // outside mousedown closes
    fireEvent.click(screen.getByRole('button', { name: /이동/ }));
    expect(await screen.findByRole('menuitem', { name: '스윙' })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '스윙' })).not.toBeInTheDocument());

    // Escape closes
    fireEvent.click(screen.getByRole('button', { name: /이동/ }));
    expect(await screen.findByRole('menuitem', { name: '스윙' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '스윙' })).not.toBeInTheDocument());
  });

  it('per-row ↻ triggers catch-up and shows a result banner', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const c = vi.spyOn(api, 'catchupNow').mockResolvedValue({ enqueued: ['x'], deduped: [] } as any);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('삼성전자 수집'));
    await waitFor(() => expect(c).toHaveBeenCalledWith('005930'));
    // banner rendered — scope to the banner's unique message text (the loose /삼성전자/
    // also matches the row name, throwing "multiple elements"). See F7 concerns.
    await waitFor(() => expect(screen.getByText(/수집 대기/)).toBeInTheDocument());
  });
});
