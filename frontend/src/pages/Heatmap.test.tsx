import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/watchlist', async (orig) => ({
  ...(await orig<typeof import('../api/watchlist')>()),
  getWatchlist: vi.fn(() => Promise.resolve({
    folders: [{ id: 'f1', name: '반도체', order: 0 }],
    entries: [
      { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f1', order: 0 },
      { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f1', order: 1 },
    ],
    next_run_at_ms: 0,
  })),
}));

// 005930(order0) -2%, 000660(order1) +5% — manual≠change 라 토글이 관측 가능.
// 005930(order0) -2%, 000660(order1) +5% — manual≠change 라 토글이 관측 가능.
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useLiveQuoteOverlay: vi.fn(() => ({
    quoteByCode: new Map([
      ['005930', { code: '005930', price: 70000, change_pct: -2, change_won: -1400 }],
      ['000660', { code: '000660', price: 200000, change_pct: 5, change_won: 10000 }],
    ]),
    phase: 'open',
    dataUpdatedAt: 0,
  })),
}));

// liveStatus: 기본 running:true → 배너 없음. 자격증명 배너 테스트에서만 override.
vi.mock('../api/liveStatus', async (orig) => ({
  ...(await orig<typeof import('../api/liveStatus')>()),
  useLiveStatus: vi.fn(() => ({ data: { running: true, started_at_ms: 1, cycle_lag_ms: 0 } })),
}));

const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) => sel({ setActiveCode }),
}));

import { Heatmap } from './Heatmap';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { useLiveStatus } from '../api/liveStatus';

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  setActiveCode.mockClear();
  useHeatmapPrefsStore.setState({ sortMode: 'manual' });   // eng-review D2: 기본 manual
  vi.mocked(useLiveStatus).mockReturnValue(
    { data: { running: true, started_at_ms: 1, cycle_lag_ms: 0 } } as ReturnType<typeof useLiveStatus>,
  );
});

it('폴더·종목·phase 배지·색 범례 렌더', async () => {
  renderPage();
  expect(await screen.findByText('반도체')).toBeInTheDocument();
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText(/장중/)).toBeInTheDocument();
  expect(screen.getByLabelText(/색 범례/)).toBeInTheDocument();   // spec §8 색 범례 바
});

it('행 클릭 → activeCode 설정(jump-to-live)', async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('heatmap-row-005930'));
  expect(setActiveCode).toHaveBeenCalledWith('005930');
});

it('기본 manual=order 순, 등락률↓ 토글 시 등락률 내림차순', async () => {
  renderPage();
  await screen.findByText('반도체');
  const manual = screen.getAllByText(/삼성전자|SK하이닉스/).map((n) => n.textContent);
  expect(manual).toEqual(['삼성전자', 'SK하이닉스']);          // order 0,1
  fireEvent.click(screen.getByRole('button', { name: '등락률 ↓' }));
  const change = screen.getAllByText(/삼성전자|SK하이닉스/).map((n) => n.textContent);
  expect(change).toEqual(['SK하이닉스', '삼성전자']);          // +5% 먼저
});

it('관심종목 있는데 KIS 자격증명 없으면(poller 미기동) 배너', async () => {
  vi.mocked(useLiveStatus).mockReturnValue(
    { data: { running: false, started_at_ms: null, cycle_lag_ms: 0 } } as ReturnType<typeof useLiveStatus>,
  );
  renderPage();
  expect(await screen.findByText('KIS 자격증명이 설정되지 않았습니다')).toBeInTheDocument();
});
