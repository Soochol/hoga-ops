import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TossOrder } from '../../api/trading';
import { OrderWindow } from './OrderWindow';
import { groupPriceOrders, orderRemainder } from './orderRules';

const mock = vi.hoisted(() => ({ configured: true, accountCount: 1, now: 1791856800000, snapshotAt: 1791856800000, orders: [] as TossOrder[], command: vi.fn() }));
vi.mock('../../api/trading', () => ({
  useTradingAccounts: () => ({ data: { configured: mock.configured, accounts: mock.configured ? Array.from({ length: mock.accountCount }, (_, index) => ({ account_seq: index + 1, label: `계좌 ${index + 1}` })) : [] }, isLoading: false }),
  useTradingState: () => ({ data: mock.configured ? { account_seq: 1, code: '005930', orders: mock.orders, recent_orders: [], buying_power: '50000000', sellable_quantity: '80', holding_quantity: '100', average_purchase_price: '66000', fetched_at_ms: mock.now, events_connected: true, unresolved_commands: [] } : undefined }),
  tradingCommand: (...args: unknown[]) => mock.command(...args),
}));
vi.mock('../../api/liveSeries', () => ({ useLiveSeries: () => ({ ob: [], latestOb: { t_ms: mock.snapshotAt, asks: Array.from({ length: 10 }, (_, i) => ({ price: 67300 + i * 100, qty: 100 + i })), bids: Array.from({ length: 10 }, (_, i) => ({ price: 67200 - i * 100, qty: 200 + i })), total_ask_qty: 1000, total_bid_qty: 2000 }, trade: [] }) }));
vi.mock('../../api/liveQuotes', () => ({ useQuoteByCode: () => new Map([['005930', { price: 67200, baseline_price: 66000 }]]) }));
vi.mock('../../api/liveStockLimits', () => ({ useLiveStockLimits: () => ({ data: { upper_limit: 85800, lower_limit: 46200 } }) }));
vi.mock('../../util/useWallClockSecond', () => ({ useWallClockSecond: () => mock.now }));

function order(id = 'a'): TossOrder {
  return { orderId: id, symbol: '005930', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', status: 'PARTIAL_FILLED', price: '67200', quantity: '100', orderAmount: null, currency: 'KRW', orderedAt: '', canceledAt: null,
    execution: { filledQuantity: '30', averageFilledPrice: '67200', filledAmount: '2016000', commission: null, tax: null, filledAt: null, settlementDate: null } };
}
function show() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>); }
beforeEach(() => { mock.orders = []; mock.configured = true; mock.accountCount = 1; mock.snapshotAt = mock.now; mock.command.mockReset().mockResolvedValue({ command_id: 'a', order_id: 'new', status: 'accepted' }); });

describe('호가 주문', () => {
  it('빈 영역 클릭은 확인 전까지 주문을 전송하지 않는다', async () => {
    const view = show(); const add = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    expect(add).toHaveTextContent(''); expect(view.container.textContent).not.toContain('⠿');
    fireEvent.click(add); expect(mock.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '주문 접수' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][2]).toBe('paper');
    expect(mock.command.mock.calls[0][1]).toMatchObject({ account_seq: 1, code: '005930', side: 'BUY', price: 67200, quantity: 10, confirm_high_value: false });
  });
  it('부분 체결을 제외한 잔량과 개별 상세를 표시한다', () => {
    mock.orders = [order()]; show(); const chip = screen.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
    expect(chip).toHaveTextContent('70주'); fireEvent.click(chip);
    expect(screen.getByLabelText('정정 수량')).toHaveValue(70); expect(screen.getByText(/주문 100주 · 체결 30주/)).toBeInTheDocument();
  });
  it('반대 주문이 있으면 신규 매도 영역을 비활성화한다', () => {
    mock.orders = [order()]; show(); expect(screen.getByRole('button', { name: /매도 67,200원 주문 추가/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeEnabled();
  });
  it('오래된 호가·무자격 신규 주문은 막되 취소 경로는 유지한다', () => {
    mock.snapshotAt = mock.now - 60_000; mock.orders = [order()]; const view = show();
    expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '삼성전자 전체 취소' })).toBeEnabled();
    view.unmount(); mock.configured = false; show(); expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeDisabled();
  });
  it('즉시 주문에서도 1억원 이상은 개별 확인을 요구한다', () => {
    show(); fireEvent.click(screen.getByRole('checkbox', { name: '즉시 주문' })); fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })); expect(mock.command).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '주문 접수' })).toBeDisabled(); fireEvent.click(screen.getByRole('checkbox', { name: '1억원 이상 주문 금액을 확인했습니다' }));
    expect(screen.getByRole('button', { name: '주문 접수' })).toBeEnabled();
  });
  it('같은 가격의 여러 주문은 합계 표시 후 개별 선택한다', () => {
    mock.orders = [order('a'), order('b')]; show(); const chip = screen.getByRole('button', { name: '매수 67,200원 2건 상세 정정' });
    expect(chip).toHaveTextContent('140주·2'); expect(chip).not.toHaveAttribute('data-drag-order'); fireEvent.click(chip);
    expect(screen.getByText('개별 주문 선택')).toBeInTheDocument(); expect(screen.getAllByRole('button', { name: '매수 잔여 70주 · 체결 30주' })).toHaveLength(2);
    const a = order(), b = { ...order('b'), side: 'SELL' as const }; expect(groupPriceOrders([a, b]).size).toBe(2); expect(orderRemainder(a)).toBe(70);
  });
  it('선택 주문의 키보드 정정과 수량 프리셋은 주문창 포커스에서 동작한다', () => {
    mock.orders = [order()]; show();
    const chip = screen.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
    fireEvent.click(chip); fireEvent.keyDown(chip, { key: 'ArrowUp', ctrlKey: true });
    expect(screen.getByLabelText('주문 가격')).toHaveValue(67300); expect(mock.command).not.toHaveBeenCalled();
    fireEvent.keyDown(chip, { key: '2', ctrlKey: true }); expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(50);
    expect(screen.getByText(/보유 100주 · 평균 매입 66,000원/)).toBeInTheDocument();
  });
  it('모의 초기화는 확인 후 로컬 API에만 전송한다', async () => {
    show();
    expect(screen.getByRole('combobox', { name: '주문 모드' })).toHaveValue('paper');
    fireEvent.click(screen.getByRole('button', { name: '모의 계좌 설정' }));
    fireEvent.change(screen.getByLabelText('모의 초기 보유 수량'), { target: { value: '100' } });
    expect(screen.getByRole('button', { name: '모의 계좌 초기화' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '모든 종목의 모의 주문·보유 내역을 지우고 초기화합니다' }));
    fireEvent.click(screen.getByRole('button', { name: '모의 계좌 초기화' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0]).toEqual(['/reset', expect.objectContaining({ cash: 100_000_000, holding_quantity: 100, average_purchase_price: 67200, confirmed: true }), 'paper']);
  });
  it('실계좌 선택 시 모의 확인·즉시 주문 상태를 정리한다', async () => {
    show();
    fireEvent.click(screen.getByRole('checkbox', { name: '즉시 주문' }));
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: 'live' } });
    expect(screen.queryByRole('button', { name: '모의 계좌 설정' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '즉시 주문' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    fireEvent.click(screen.getByRole('button', { name: '주문 접수' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][2]).toBe('live');
  });

  it('종목을 바꿔도 선택한 실계좌를 유지하고 이전 확인은 닫는다', async () => {
    mock.accountCount = 2;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>);
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: 'live' } });
    fireEvent.change(screen.getByRole('combobox', { name: '주문 계좌' }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    expect(screen.getByRole('group', { name: '주문 확인' })).toBeInTheDocument();
    view.rerender(<QueryClientProvider client={client}><OrderWindow code="000660" name="SK하이닉스" /></QueryClientProvider>);
    expect(screen.getByRole('combobox', { name: '주문 계좌' })).toHaveValue('2');
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    fireEvent.click(screen.getByRole('button', { name: '주문 접수' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0]).toEqual(['/orders', expect.objectContaining({ account_seq: 2, code: '000660' }), 'live']);
  });

});
