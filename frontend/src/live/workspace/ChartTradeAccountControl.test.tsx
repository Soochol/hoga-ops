import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChartTradeAccountControl } from './ChartTradeAccountControl';
import { ChartWindowSettings } from './ChartWindowSettings';
import { useWindowSettingsStore } from '../../state/windowSettings';
import { useChartTradeAccounts } from '../../state/chartTradeAccounts';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { apiCall } from '../../api/client';

vi.mock('../../api/client', () => ({ apiCall: vi.fn() }));

const a = `acc_${'a'.repeat(32)}`, b = `acc_${'b'.repeat(32)}`;
beforeEach(() => {
  useWindowSettingsStore.setState({ byWindow: {} }); useChartTradeAccounts.setState({ byWindow: {} });
  useChartPrefsStore.getState().resetToDefaults(); localStorage.clear();
});

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
