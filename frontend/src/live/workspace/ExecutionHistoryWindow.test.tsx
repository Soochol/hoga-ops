import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiCall } from '../../api/client';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import { ExecutionHistoryWindow } from './ExecutionHistoryWindow';
vi.mock('../../api/client', () => ({ apiCall: vi.fn() }));
vi.mock('../../api/ws', () => ({ subscribeEvents: () => () => {} }));
vi.mock('../../capture/useSymbols', () => ({ useSymbols: () => ({ data: { symbols: [{ code: '007810', name: '코리아써키트' }] } }) }));
const A = `acc_${'a'.repeat(32)}`, B = `acc_${'b'.repeat(32)}`;
const account = (ref: string, label: string) => ({ account_ref: ref, broker: ref === A ? 'toss' : 'kiwoom', label, environment: 'real', routes: ['SOR'] });
const entry = { order_ref: 'order-1', broker_order_id: 'native', code: '007810', name: null, side: 'BUY', quantity: '12',
  order_quantity: '100', price: '80500', price_basis: 'average', amount: '966000', filled_at: '2026-10-28T15:10:01+09:00', ordered_at: null, route: 'SOR' };
const history: WorkspaceWindow = { id: 'history', kind: 'account-fills', group: 1, rect: { x: 0, y: 0, w: .5, h: .5 }, executionHistory: { sourceOrderId: 'source', account: A } };
function Harness() { const win = useWorkspaceStore(s => s.windows.find(w => w.id === history.id)!); return <ExecutionHistoryWindow win={win} />; }
function mount() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Harness /></QueryClientProvider>); }
beforeEach(() => {
  vi.mocked(apiCall).mockReset();
  useWorkspaceStore.setState({ windows: [{ ...history, id: 'source', kind: 'order', orderAccount: A }, history],
    groupSymbols: { 1: { code: '007810', name: '코리아써키트' } }, zOrder: ['source', 'history'] });
  vi.mocked(apiCall).mockImplementation(url => Promise.resolve(String(url).endsWith('/accounts')
    ? { configured: true, accounts: [account(A, '토스증권 · ****1234'), account(B, '키움증권 · ****5678')] }
    : { account_ref: String(url).includes(B) ? B : A, date: new URL(String(url), 'http://test').searchParams.get('date'),
      rows: String(url).includes(B) ? [] : [entry], next_key: null, fetched_at_ms: Date.now(), events_connected: true }));
});
afterEach(cleanup);

it('renders the approved table without a status column and keeps account executions independent of venue', async () => {
  mount();
  expect(await screen.findByRole('button', { name: /코리아써키트/ })).toBeVisible();
  expect(screen.getAllByRole('columnheader').map(c => c.textContent)).toEqual(['체결시각', '종목', '구분', '체결수량', '체결가', '체결금액']);
  expect(screen.getByText('12주')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '매도' }));
  expect(await screen.findByText('조회 조건에 맞는 체결내역 없음')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '전체' }));
  fireEvent.click(screen.getByRole('button', { name: /코리아써키트/ }));
  expect(screen.getByText('평균체결가')).toBeVisible();
  expect(vi.mocked(apiCall).mock.calls.every(([url]) => !String(url).includes('venue='))).toBe(true);
});

it('clears old account rows immediately while the newly linked account loads, and retains the last account on close', async () => {
  mount(); await screen.findByText('12주');
  let resolve!: (value: unknown) => void;
  vi.mocked(apiCall).mockImplementation(() => new Promise(done => { resolve = done; }));
  act(() => useWorkspaceStore.getState().setOrderAccount('source', B));
  expect(screen.queryByText('12주')).not.toBeInTheDocument();
  expect(screen.getByText('체결내역 불러오는 중…')).toBeVisible();
  await waitFor(() => expect(resolve).toBeDefined());
  await act(async () => resolve({ account_ref: B, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', ''), rows: [], next_key: null, fetched_at_ms: 1, events_connected: false }));
  act(() => useWorkspaceStore.getState().closeWindow('source'));
  expect(within(screen.getByTestId('execution-history-window')).getByText('키움증권 · ****5678')).toBeVisible();
  expect(screen.getByRole('option', { name: '연결 종료 · 마지막 계좌 유지' })).toBeInTheDocument();
});
