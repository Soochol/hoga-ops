import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChartTradeAccountControl } from './ChartTradeAccountControl';
import { ChartWindowSettings } from './ChartWindowSettings';
import { useWindowSettingsStore } from '../../state/windowSettings';
import { useChartTradeAccounts } from '../../state/chartTradeAccounts';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { apiCall } from '../../api/client';
import { useWorkspaceStore, windowSymbolOf } from '../../state/workspace';
import type { ExecutionHistoryPage, ExecutionHistoryRow } from '../../api/executionHistory';

vi.mock('../../api/client', () => ({ apiCall: vi.fn() }));
vi.mock('../../api/ws', () => ({ subscribeEvents: () => () => {} }));

const a = `acc_${'a'.repeat(32)}`, b = `acc_${'b'.repeat(32)}`;
beforeEach(() => {
  vi.mocked(apiCall).mockReset();
  useWindowSettingsStore.setState({ byWindow: {} }); useChartTradeAccounts.setState({ byWindow: {} });
  useChartPrefsStore.getState().resetToDefaults(); localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('adds a window-owned toggle in chart settings and reveals only that window account selector', async () => {
  const fetcher = vi.mocked(apiCall).mockResolvedValue({ configured: true,
    accounts: [{ account_ref: a, label: '키움 1234' }, { account_ref: b, label: '키움 5678' }], errors: {} });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ChartWindowSettings windowId="a" />
    <ChartTradeAccountControl windowId="a" /><ChartTradeAccountControl windowId="b" /></QueryClientProvider>);
  expect(screen.queryByRole('combobox', { name: '매매 계좌' })).not.toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '차트 설정' }));
  fireEvent.click(screen.getByRole('switch', { name: '매매내역 표시' }));
  const select = await screen.findByRole('combobox', { name: '매매 계좌' });
  await screen.findByRole('option', { name: '키움 1234' });
  expect(select).toHaveValue('');
  fireEvent.change(select, { target: { value: a } });
  expect(useChartTradeAccounts.getState().byWindow).toEqual({ a });
  act(() => useWindowSettingsStore.getState().patch('a', 'chart', { accountExecutionsEnabled: false }));
  expect(screen.queryByRole('combobox', { name: '매매 계좌' })).not.toBeInTheDocument();
  act(() => useWindowSettingsStore.getState().patch('a', 'chart', { accountExecutionsEnabled: true }));
  expect(screen.getByRole('combobox', { name: '매매 계좌' })).toHaveValue(a);
  expect(JSON.parse(localStorage.getItem('hoga.chart.trade.accounts.v1')!).byWindow).toEqual({ a });
  fetcher.mockRestore(); client.clear();
});

const today = '20261029';
const fill = (code: string, name: string | null, clock: string | null): ExecutionHistoryRow => ({
  order_ref: `${code}-${clock}`, broker_order_id: code, code, name, side: 'BUY', quantity: '10', order_quantity: '10',
  price: '10000', price_basis: 'execution', amount: null, route: 'KRX',
  filled_at: clock ? `2026-10-29T${clock}:00+09:00` : null, ordered_at: '2026-10-29T16:00:00+09:00',
});
const history = (account: string, rows: ExecutionHistoryRow[], next_key: string | null = null): ExecutionHistoryPage => ({
  account_ref: account, date: today, rows, next_key, fetched_at_ms: 1, events_connected: true,
});
function recentSetup() {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T18:00:00+09:00'));
  useWorkspaceStore.setState({ windows: [{ id: 'a', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: .5, h: .5 }, chart: { timeframe: '1m' } }],
    zOrder: ['a'], groupSymbols: { 1: { code: '005930', name: '삼성전자' } } });
  useWindowSettingsStore.getState().patch('a', 'chart', { accountExecutionsEnabled: true });
  vi.mocked(apiCall).mockImplementation(async url => {
    if (url === '/api/trading/v2/accounts') return { configured: true,
      accounts: [{ account_ref: a, label: '계좌 A' }, { account_ref: b, label: '계좌 B' }], errors: {} };
    if (String(url).includes('execution-history-range')) {
      const p = new URL(String(url), 'http://localhost').searchParams;
      return { account_ref: p.get('account_ref'), from_date: p.get('from_date'), to_date: p.get('to_date'),
        rows: [], next_key: null, scanned_through: p.get('from_date'), fetched_at_ms: 1, events_connected: true };
    }
    if (String(url).includes('execution-history')) {
      if (String(url).includes(b)) return history(b, [fill('035720', '카카오', '10:00')]);
      if (String(url).includes('next_key=')) return history(a, [fill('0099A0', null, '08:10')]);
      return history(a, [fill('005930', '삼성전자', '09:10'), fill('000660', 'SK하이닉스', '09:20'),
        fill('005930', '삼성전자', '09:30'), fill('035420', null, null)], 'page-2');
    }
    return { symbols: [{ code: '035420', name: 'NAVER' }, { code: '0099A0', name: '새 종목' }] };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><ChartTradeAccountControl windowId="a" /></QueryClientProvider>);
  return { client, view };
}
const historyCalls = () => vi.mocked(apiCall).mock.calls.filter(([url]) => String(url).includes('execution-history'));

it('loads only when opened with a known account, lists deduplicated fills, and preserves account/B/S on stock selection', async () => {
  const { client, view } = recentSetup();
  const trigger = screen.getByRole('button', { name: '최근 매매' });
  expect(trigger).toBeDisabled();
  await screen.findByRole('option', { name: '계좌 A' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: a } });
  expect(historyCalls()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '최근 매매' }));
  const dialog = screen.getByRole('dialog', { name: '최근 매매 종목' });
  await within(dialog).findByRole('button', { name: /SK하이닉스/ });
  expect([...dialog.querySelectorAll('[data-recent-code]')].map(el => el.getAttribute('data-recent-code'))).toEqual(['005930', '000660', '035420']);
  expect(within(dialog).getByRole('button', { name: /삼성전자/ })).toHaveAttribute('aria-pressed', 'true');
  const naver = await within(dialog).findByRole('button', { name: /NAVER/ });
  expect(naver.querySelector('time span:last-child')).toBeEmptyDOMElement();
  fireEvent.keyDown(dialog, { key: 'Home' });
  expect(within(dialog).getByRole('button', { name: /삼성전자/ })).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'ArrowDown' });
  expect(within(dialog).getByRole('button', { name: /SK하이닉스/ })).toHaveFocus();
  fireEvent.click(within(dialog).getByRole('button', { name: '더 조회' }));
  await within(dialog).findByRole('button', { name: /새 종목/ });
  expect(within(dialog).queryByRole('button', { name: '더 조회' })).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: /SK하이닉스/ }));
  const state = useWorkspaceStore.getState();
  expect(windowSymbolOf(state, state.windows[0])?.code).toBe('000660');
  expect(useChartTradeAccounts.getState().byWindow.a).toBe(a);
  expect(useWindowSettingsStore.getState().byWindow.a.chart?.accountExecutionsEnabled).toBe(true);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '최근 매매' })).toHaveFocus();
  view.unmount(); client.clear();
});

it('closes on account switches, isolates lists, respects pinned windows, and hides with the display toggle', async () => {
  const { client, view } = recentSetup();
  await screen.findByRole('option', { name: '계좌 A' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: a } });
  fireEvent.click(screen.getByRole('button', { name: '최근 매매' }));
  await screen.findByRole('button', { name: /SK하이닉스/ });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: b } });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  act(() => useWorkspaceStore.setState(state => ({ windows: state.windows.map(w => ({ ...w, pinned: { code: '005930', name: '삼성전자' } })) })));
  fireEvent.click(screen.getByRole('button', { name: '최근 매매' }));
  expect(await screen.findByRole('button', { name: /카카오/ })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /SK하이닉스/ })).not.toBeInTheDocument();
  expect(screen.getByText('종목 고정을 해제하면 선택할 수 있습니다.')).toBeVisible();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.getByRole('button', { name: '최근 매매' })).toHaveFocus();
  act(() => useWindowSettingsStore.getState().patch('a', 'chart', { accountExecutionsEnabled: false }));
  expect(screen.queryByRole('button', { name: '최근 매매' })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  await waitFor(() => expect(historyCalls().some(([url]) => String(url).includes(b))).toBe(true));
  view.unmount(); client.clear();
});
