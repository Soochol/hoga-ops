import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/watchlist', async (orig) => ({
  ...(await orig<typeof import('../api/watchlist')>()),
  getWatchlist: vi.fn(() => Promise.resolve({
    folders: [{ id: 'f1', name: '반도체', order: 0 }],
    entries: [{ code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f1', order: 0 }],
    next_run_at_ms: 0,
  })),
  createFolder: vi.fn(() => Promise.resolve({ id: 'f2', name: '방산', order: 1 })),
}));
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useQuotes: vi.fn(() => ({ data: { phase: 'open', quotes: [] }, dataUpdatedAt: 0 })),
}));
const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) => sel({ setActiveCode }),
}));

import { Heatmap } from './Heatmap';
import { createFolder } from '../api/watchlist';

beforeEach(() => { vi.clearAllMocks(); });

it('＋새 그룹 → 이름 입력 → 만들기 시 createFolder 호출', async () => {
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '＋ 새 그룹' }));
  fireEvent.change(screen.getByPlaceholderText('그룹 이름 입력'), { target: { value: '방산' } });
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  await waitFor(() => expect(createFolder).toHaveBeenCalledWith('방산'));
});
