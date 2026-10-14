import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { AccountTradingPanel } from './AccountTradingPanel';
import type { TossOrder } from '../../api/trading';

const mock = vi.hoisted(() => ({ command: vi.fn(), paused: false }));
const orders: TossOrder[] = [
  { orderId: 'buy', symbol: '005930', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', status: 'PARTIAL_FILLED', price: '67200', quantity: '100', currency: 'KRW', orderedAt: '', canceledAt: null, orderAmount: null,
    execution: { filledQuantity: '78', filledAt: null, averageFilledPrice: null, filledAmount: null, commission: null, tax: null, settlementDate: null } },
  { orderId: 'sell', symbol: '000660', side: 'SELL', orderType: 'LIMIT', timeInForce: 'DAY', status: 'PENDING', price: '185000', quantity: '5', currency: 'KRW', orderedAt: '', canceledAt: null, orderAmount: null,
    execution: { filledQuantity: '0', filledAt: null, averageFilledPrice: null, filledAmount: null, commission: null, tax: null, settlementDate: null } },
];
vi.mock('../../api/trading', () => ({
  tradingCommand: (...args: unknown[]) => mock.command(...args),
  useTradingAccountList: () => ({ orders: { data: { orders, recent_orders: [] }, isPending: false, isError: false, isFetching: false },
    holdings: { data: { holdings: [{ code: '000660', name: 'SK하이닉스', quantity: '22', average_purchase_price: '180000' }] }, isPending: false, isError: false, isFetching: false }, paused: mock.paused }),
}));
vi.mock('../../capture/useSymbols', () => ({ useSymbols: () => ({ data: { symbols: [{ code: '005930', name: '삼성전자' }, { code: '000660', name: 'SK하이닉스' }] } }) }));
beforeEach(() => { mock.paused = false; mock.command.mockReset().mockResolvedValue({ order_id: 'cancel-op', status: 'accepted' }); });
function show(tab: 'orders' | 'holdings' = 'orders') {
  const onClose = vi.fn(), onSelectSymbol = vi.fn(), onTabChange = vi.fn();
  const client = new QueryClient();
  const anchorRef = { current: document.createElement('div') };
  const view = render(<QueryClientProvider client={client}><AccountTradingPanel account={1} accountLabel="계좌 1" tab={tab}
    anchorRef={anchorRef} onClose={onClose} onTabChange={onTabChange} onSelectSymbol={onSelectSymbol} /></QueryClientProvider>);
  return { ...view, onClose, onSelectSymbol, onTabChange };
}
it('filters order sides and cancels the other symbol only once while a response is pending', async () => {
  let release!: (value: { order_id: string }) => void;
  mock.command.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  show();
  const panel = screen.getByRole('dialog', { name: '계좌 목록' });
  fireEvent.click(within(panel).getByRole('button', { name: '매도' }));
  expect(within(panel).queryByRole('button', { name: '삼성전자' })).not.toBeInTheDocument();
  const button = within(panel).getByRole('button', { name: 'SK하이닉스 매도 주문 1 취소' });
  fireEvent.click(button); fireEvent.click(button);
  expect(mock.command).toHaveBeenCalledOnce();
  expect(mock.command.mock.calls[0]).toEqual(['/orders/sell/cancel', { account_seq: 1, code: '000660', command_id: expect.any(String) }, 'live']);
  expect(button).toBeDisabled();
  await act(async () => release({ order_id: 'cancel-op' }));
  await waitFor(() => expect(within(panel).getByRole('button', { name: 'SK하이닉스 매도 주문 1 확인 중' })).toBeDisabled());
});
it('rechecks a failed cancellation with the same request ID', async () => {
  mock.command.mockRejectedValueOnce(new Error('취소 결과 확인 필요'));
  show();
  fireEvent.click(screen.getByRole('button', { name: '삼성전자 매수 주문 1 취소' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '삼성전자 매수 주문 1 재확인' }));
  await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
  expect(mock.command.mock.calls[1]).toEqual(mock.command.mock.calls[0]);
});
it('a holding selects its symbol without placing an order and closes the panel', () => {
  const { onSelectSymbol, onClose } = show('holdings');
  fireEvent.click(screen.getByRole('button', { name: 'SK하이닉스' }));
  expect(onSelectSymbol).toHaveBeenCalledWith('000660', 'SK하이닉스');
  expect(onClose).toHaveBeenCalledOnce(); expect(mock.command).not.toHaveBeenCalled();
});
it('moves between account tabs with the keyboard without sending a trading command', () => {
  const { onTabChange } = show();
  const ordersTab = screen.getByRole('tab', { name: '미체결 주문' });
  const holdingsTab = screen.getByRole('tab', { name: '보유종목' });
  ordersTab.focus();
  fireEvent.keyDown(ordersTab, { key: 'ArrowRight' });
  expect(onTabChange).toHaveBeenCalledWith('holdings');
  expect(holdingsTab).toHaveFocus();
  expect(ordersTab).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id);
  expect(mock.command).not.toHaveBeenCalled();
});
