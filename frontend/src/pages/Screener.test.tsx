import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi } from 'vitest';

vi.mock('../api/screener', async (orig) => ({
  ...(await orig<typeof import('../api/screener')>()),
  runScan: vi.fn(() => Promise.resolve({ status: 'ok', warnings: [], rows: [
    { code: '005930', name: '삼성전자', market: 'KOSPI', price: 74200, trade_value_won: 842_000_000_000, change_pct: 5.8 }] })),
  getScreenerStatus: vi.fn(() => Promise.resolve({ status: 'ok', last_raw_date: '20260530', days_behind: 0 })),
  triggerScreenerUpdate: vi.fn(),
}));
vi.mock('../api/savedScreeners', () => ({
  listSaves: vi.fn(() => Promise.resolve({ schema_version: 1, saves: [] })),
  createSave: vi.fn(), updateSave: vi.fn(), deleteSave: vi.fn(),
}));

// useLivePageStore lives at ../state/livePage (the path LiveStatusBar imports);
// `../live/useLivePageStore` does not exist. Mock the real module so clicking a
// row drives the real selector. vi.hoisted avoids the TDZ ReferenceError that a
// bare `const setActiveCode = vi.fn()` referenced inside the hoisted factory
// would otherwise throw.
const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) =>
    sel({ setActiveCode }),
}));

import { Screener } from './Screener';
import { runScan } from '../api/screener';

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Screener /></MemoryRouter></QueryClientProvider>);
}

it('runs scan and renders row; click sets activeCode', async () => {
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  await waitFor(() => screen.getByText('삼성전자'));
  fireEvent.click(screen.getByText('삼성전자'));
  expect(setActiveCode).toHaveBeenCalledWith('005930');
});

it('row is keyboard-activatable', async () => {
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  const row = await screen.findByText('삼성전자');
  fireEvent.keyDown(row.closest('[role="button"]')!, { key: 'Enter' });
  expect(setActiveCode).toHaveBeenCalledWith('005930');
});

it('surfaces a scan error instead of a silent dead-end', async () => {
  vi.mocked(runScan).mockRejectedValueOnce(new Error('422'));
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  expect(await screen.findByText('조회 실패 — 조건을 확인하세요')).toBeInTheDocument();
});
