import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi } from 'vitest';

vi.mock('../api/screener', () => ({
  runScreener: vi.fn(async () => ({ status: 'ok', rows: [{
    code: '005930', name: '삼성전자', market: 'KOSPI', price: 317000,
    trade_value_won: 1, change_pct: 5.8,
    new_high: { hit: true, event_date: '20260514', days_ago: 0, period_extreme: 323000 },
    new_high_vol: { hit: false } }] })),
  getScreenerStatus: vi.fn(async () => ({ status: 'ok', last_raw_date: '20260514' })),
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
