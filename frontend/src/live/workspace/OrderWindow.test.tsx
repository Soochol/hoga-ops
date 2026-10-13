import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TossOrder } from '../../api/trading';
import { OrderWindow } from './OrderWindow';
import { DataWindow } from './DataWindow';
import type { WorkspaceWindow } from '../../state/workspace';
import { groupPriceOrders, holdingProfitWon, orderRemainder } from './orderRules';

const mock = vi.hoisted(() => ({ configured: true, accountCount: 1, priceOffset: 0, quotePrice: 67200 as number | null, buyingPower: '50000000', averagePrice: '66000', now: 1791856800000, snapshotAt: 1791856800000, orders: [] as TossOrder[], command: vi.fn() }));
vi.mock('../../api/trading', () => ({
  useTradingAccounts: () => ({ data: { configured: mock.configured, accounts: mock.configured ? Array.from({ length: mock.accountCount }, (_, index) => ({ account_seq: index + 1, label: `계좌 ${index + 1}` })) : [] }, isLoading: false }),
  useTradingState: () => ({ data: mock.configured ? { account_seq: 1, code: '005930', orders: mock.orders, recent_orders: [], buying_power: mock.buyingPower, sellable_quantity: '80', holding_quantity: '100', average_purchase_price: mock.averagePrice, fetched_at_ms: mock.now, events_connected: true, unresolved_commands: [] } : undefined }),
  tradingCommand: (...args: unknown[]) => mock.command(...args),
}));
vi.mock('../../api/liveSeries', () => ({ useLiveSeries: () => ({ ob: [], latestOb: { t_ms: mock.snapshotAt, asks: Array.from({ length: 10 }, (_, i) => ({ price: 67300 + mock.priceOffset + i * 100, qty: 100 + i })), bids: Array.from({ length: 10 }, (_, i) => ({ price: 67200 + mock.priceOffset - i * 100, qty: 200 + i })), total_ask_qty: 1000, total_bid_qty: 2000 }, trade: [] }) }));
vi.mock('../../api/liveQuotes', () => ({ useQuoteByCode: () => new Map([['005930', { price: mock.quotePrice, baseline_price: 66000, open: 68000, high: 69000, low: 67000, volume: 8336637, trade_value: 12290807000000, vs_prev_volume_pct: 184.55 }]]) }));
vi.mock('../../api/liveStockLimits', () => ({ useLiveStockLimits: () => ({ data: { base_price: 66000, upper_limit: 85800, lower_limit: 46200, high_250: 70000, low_250: 50000 } }) }));
vi.mock('../../api/liveKrxClose', () => ({ useLiveKrxClose: () => ({ data: { date: '20261013', price: 67100 } }) }));
vi.mock('../../api/liveViStatus', () => ({ useLiveViStatus: () => ({ data: { vi: null } }) }));
vi.mock('../../util/useWallClockSecond', () => ({ useWallClockSecond: () => mock.now }));

function order(id = 'a'): TossOrder {
  return { orderId: id, symbol: '005930', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', status: 'PARTIAL_FILLED', price: '67200', quantity: '100', orderAmount: null, currency: 'KRW', orderedAt: '', canceledAt: null,
    execution: { filledQuantity: '30', averageFilledPrice: '67200', filledAmount: '2016000', commission: null, tax: null, filledAt: null, settlementDate: null } };
}
function show() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>); }
beforeEach(() => { mock.orders = []; mock.configured = true; mock.accountCount = 1; mock.priceOffset = 0; mock.quotePrice = 67200; mock.buyingPower = '50000000'; mock.averagePrice = '66000'; mock.snapshotAt = mock.now; mock.command.mockReset().mockResolvedValue({ command_id: 'a', order_id: 'new', status: 'accepted' }); });

describe('호가 주문', () => {
  it('평가수익은 소수 평단가로 계산해 올림하고 정수 경계에서 1원 오차를 만들지 않는다', () => {
    expect(holdingProfitWon(100, 67200, '44669.963')).toBe(2253004);
    expect(holdingProfitWon(100, 67200, '66000.01')).toBe(119999);
    expect(holdingProfitWon(100, 67200, '67500.125')).toBe(-30012);
    expect(holdingProfitWon(0, null, null)).toBe(0);
    expect(holdingProfitWon(100, null, '66000')).toBeNull();
    expect(holdingProfitWon(100, 67200, null)).toBeNull();
  });
  it('설정 취소는 프리셋을 바꾸지 않고 적용된 프리셋·단축키로 즉시 주문한다', async () => {
    const view = show();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    fireEvent.change(screen.getByLabelText('수량 프리셋 1'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(10);
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    expect(screen.getByLabelText('수량 프리셋 1')).toHaveValue(10);
    for (const [i, value] of [25, 75, 250].entries()) fireEvent.change(screen.getByLabelText(`수량 프리셋 ${i + 1}`), { target: { value: String(value) } });
    fireEvent.change(screen.getByLabelText('금액 프리셋 1'), { target: { value: '1.5' } });
    expect(screen.getByRole('button', { name: '적용' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('금액 프리셋 1'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(25);
    fireEvent.keyDown(view.getByTestId('order-window'), { key: '2', ctrlKey: true });
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(75);
    expect(screen.getByRole('button', { name: '250주' })).toBeInTheDocument();
    expect(mock.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ quantity: 75 });
  });
  it('금액은 백만원으로 입력하고 현재가가 아닌 클릭 호가로 양방향 주수를 계산한다', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    fireEvent.click(screen.getByRole('radio', { name: '금액' }));
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(screen.getByLabelText('신규 주문 금액')).toHaveValue(1);
    fireEvent.click(screen.getByRole('button', { name: '5백만' }));
    expect(screen.getByLabelText('예상 주문 수량')).toHaveTextContent('74주');
    fireEvent.click(screen.getByRole('button', { name: /매수 68,000원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ side: 'BUY', price: 68000, quantity: 73 });
    const sell = screen.getByRole('button', { name: /매도 66,300원 주문 추가/ });
    await waitFor(() => expect(sell).toBeEnabled()); fireEvent.click(sell);
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1][1]).toMatchObject({ side: 'SELL', price: 66300, quantity: 75 });
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    fireEvent.click(screen.getByRole('radio', { name: '수량' })); fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(10);
  });
  it('금액이 1주 미만이면 예상 0주를 표시하고 신규 주문을 제한한다', () => {
    mock.priceOffset = 1400000; mock.quotePrice = 1467200; show();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    fireEvent.click(screen.getByRole('radio', { name: '금액' })); fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(screen.getByLabelText('예상 주문 수량')).toHaveTextContent('0주');
    expect(screen.getByRole('button', { name: /매수 1,467,200원 주문 추가/ })).toBeDisabled();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('공통 수량을 양방향 주문에 사용하고 현재가·선택 호가의 예상 금액을 표시한다', async () => {
    const view = show();
    expect(screen.queryByLabelText('수량 방향')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('주문 기준 금액')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '매도 25%' })).not.toBeInTheDocument();
    const preset = screen.getByRole('button', { name: '50주' });
    fireEvent.click(preset);
    expect(preset).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('3,360,000원');
    const buy = screen.getByRole('button', { name: /매수 67,300원 주문 추가/ });
    fireEvent.pointerEnter(buy.closest('.order-row')!);
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('3,365,000원67,300원 기준');
    fireEvent.click(buy);
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ side: 'BUY', quantity: 50, price: 67300 });
    const sell = screen.getByRole('button', { name: /매도 67,200원 주문 추가/ });
    await waitFor(() => expect(sell).toBeEnabled());
    fireEvent.click(sell);
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1][1]).toMatchObject({ side: 'SELL', quantity: 50, price: 67200 });
    fireEvent.pointerLeave(view.container.querySelector('.order-ladder')!);
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('3,360,000원');
  });
  it('보유 정보와 매수 가능 금액은 상단에만 표시하고 시세 상세는 10호가 형식을 쓴다', () => {
    mock.buyingPower = '9759'; mock.averagePrice = '44669.963'; show();
    expect(screen.getByLabelText('매수 가능 금액')).toHaveTextContent('매수 가능9,759원');
    expect(screen.queryByLabelText('매도 가능 수량')).not.toBeInTheDocument();
    expect(screen.getByLabelText('매입수량')).toHaveTextContent('매입수량100주');
    expect(screen.getByLabelText('매입평단가')).toHaveTextContent('매입평단가44,670원');
    expect(screen.getByLabelText('보유 종목 평가 수익')).toHaveTextContent('평가수익2,253,004원');
    expect(within(screen.getByRole('group', { name: '보유 종목 정보' })).getByLabelText('매입수량')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: '보유 종목 정보' })).getByLabelText('매수 가능 금액')).toBeInTheDocument();
    const summary = within(screen.getByTestId('book-summary'));
    expect(summary.queryByText('매수 가능')).not.toBeInTheDocument();
    expect(summary.queryByText('매도 가능')).not.toBeInTheDocument();
    for (const label of ['KRX종가', '상한가', '하한가', '상승VI', '하강VI', '250일']) expect(summary.getByText(label)).toBeInTheDocument();
    expect(summary.getByText('833만')).toBeInTheDocument();
    expect(summary.getByText('184.55%')).toBeInTheDocument();
    expect(summary.getByText('12조 2,908억')).toBeInTheDocument();
    expect(summary.getByText('70,000/50,000')).toBeInTheDocument();
  });
  it('가격이나 유효 수량이 없으면 예상 금액을 계산하지 않고 잘못된 수량은 전송하지 않는다', () => {
    mock.quotePrice = null; show();
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('—');
    expect(screen.getByLabelText('보유 종목 평가 수익')).toHaveTextContent('—');
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    expect(mock.command).not.toHaveBeenCalled();
    expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent('정수');
  });
  it('보유 평가 수익은 원본 평단가·전체 보유 수량·현재가로 계산하고 선택 호가·주문 수량에는 영향받지 않는다', () => {
    mock.buyingPower = '9759'; show();
    const valuation = screen.getByLabelText('보유 종목 평가 수익');
    expect(screen.getByLabelText('매입수량')).toHaveTextContent('100주');
    expect(screen.getByLabelText('매입평단가')).toHaveTextContent('66,000원');
    expect(valuation).toHaveTextContent('120,000원'); // 전체 보유 100주, 매도 가능 80주
    expect(screen.getByLabelText('매입평단가').nextElementSibling).toBe(valuation);
    fireEvent.pointerEnter(screen.getByRole('button', { name: /매수 67,300원 주문 추가/ }).closest('.order-row')!);
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '50' } });
    expect(valuation).toHaveTextContent('120,000원');
    mock.quotePrice = 67400;
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '20' } });
    expect(valuation).toHaveTextContent('140,000원');
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('왼쪽 매도·오른쪽 매수 영역 클릭은 확인창 없이 즉시 주문한다', async () => {
    const view = show(); const add = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    expect(add).toHaveTextContent(''); expect(view.container.textContent).not.toContain('⠿');
    const row = add.closest('.order-row')!;
    expect(Array.from(row.querySelectorAll('[data-order-side]')).map(lane => (lane as HTMLElement).dataset.orderSide)).toEqual(['SELL', 'BUY']);
    expect(view.container.querySelector('.order-topline,.order-quote,.order-footer,.order-position,.order-cancel-zone,.order-status,.order-history')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '즉시 주문' })).not.toBeInTheDocument();
    fireEvent.click(add);
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '주문 접수' })).not.toBeInTheDocument();
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
  it('오래된 호가·무자격 신규 주문은 막되 개별 취소는 즉시 처리한다', async () => {
    mock.snapshotAt = mock.now - 60_000; mock.orders = [order()]; const view = show();
    expect(screen.queryByText('실시간 호가 갱신 대기 · 신규·정정 주문 제한 · 취소는 계좌 연결 시 가능')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '매수 67,200원 1건 상세 정정' }));
    fireEvent.click(screen.getByRole('button', { name: '이 주문 취소' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][0]).toBe('/orders/a/cancel');
    view.unmount(); mock.configured = false; show(); expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeDisabled();
  });
  it('모의 고액 주문은 즉시 보내고 실계좌의 필수 금액 확인만 유지한다', async () => {
    show(); fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ quantity: 2000, confirm_high_value: true });
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: 'live' } });
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    expect(mock.command).toHaveBeenCalledOnce();
    expect(screen.getByRole('group', { name: '고액 주문 확인' })).toBeInTheDocument();
    expect(screen.queryByLabelText('주문 가격')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '확인 후 주문' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '1억원 이상 주문 금액을 확인했습니다' }));
    fireEvent.click(screen.getByRole('button', { name: '확인 후 주문' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1][2]).toBe('live');
  });
  it('같은 가격의 여러 주문은 합계 표시 후 개별 선택한다', () => {
    mock.orders = [order('a'), order('b')]; show(); const chip = screen.getByRole('button', { name: '매수 67,200원 2건 상세 정정' });
    expect(chip).toHaveTextContent('140주·2'); expect(chip).not.toHaveAttribute('data-drag-order'); fireEvent.click(chip);
    expect(screen.getByText('개별 주문 선택')).toBeInTheDocument(); expect(screen.getAllByRole('button', { name: '매수 잔여 70주 · 체결 30주' })).toHaveLength(2);
    const a = order(), b = { ...order('b'), side: 'SELL' as const }; expect(groupPriceOrders([a, b]).size).toBe(2); expect(orderRemainder(a)).toBe(70);
  });
  it('선택 주문의 키보드 정정은 즉시 보내고 수량 프리셋을 유지한다', async () => {
    mock.orders = [order()]; show();
    const chip = screen.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
    fireEvent.click(chip); fireEvent.keyDown(chip, { key: 'ArrowUp', ctrlKey: true });
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ price: 67300, quantity: null });
    await waitFor(() => expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeEnabled());
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    fireEvent.keyDown(chip, { key: '2', ctrlKey: true }); expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(50);
    expect(screen.queryByText(/보유 100주 · 평균 매입/)).not.toBeInTheDocument();
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
  it('실계좌 선택 후에도 기본 클릭으로 즉시 주문한다', async () => {
    show();
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: 'live' } });
    expect(screen.queryByRole('button', { name: '모의 계좌 설정' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '즉시 주문' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][2]).toBe('live');
  });

  it('종목을 바꿔도 선택한 실계좌를 유지하고 이전 확인은 닫는다', async () => {
    mock.accountCount = 2; mock.orders = [order()];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const win: WorkspaceWindow = { id: 'order-context', kind: 'order', group: 1, rect: { x: 0, y: 0, w: 720, h: 720 } };
    const view = render(<QueryClientProvider client={client}><DataWindow win={win} symbol={{ code: '005930', name: '삼성전자' }} /></QueryClientProvider>);
    await screen.findByRole('combobox', { name: '주문 모드' });
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: 'live' } });
    fireEvent.change(screen.getByRole('combobox', { name: '주문 계좌' }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '매수 67,200원 1건 상세 정정' }));
    expect(screen.getByRole('group', { name: '주문 확인' })).toBeInTheDocument();
    mock.orders = [];
    view.rerender(<QueryClientProvider client={client}><DataWindow win={win} symbol={{ code: '000660', name: 'SK하이닉스' }} /></QueryClientProvider>);
    expect(screen.getByRole('combobox', { name: '주문 계좌' })).toHaveValue('2');
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0]).toEqual(['/orders', expect.objectContaining({ account_seq: 2, code: '000660' }), 'live']);
  });

  it('실패는 신규 확인창 없이 알리고 재확인은 같은 요청 ID를 사용한다', async () => {
    mock.command.mockRejectedValueOnce(new Error('주문 처리 결과 확인 필요'));
    show(); fireEvent.click(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent('주문 처리 결과 확인 필요'));
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '주문 접수' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '같은 요청 다시 확인' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1]).toEqual(mock.command.mock.calls[0]);
  });
  it('하단 취소 버튼 대신 전체 취소 단축키를 유지한다', async () => {
    mock.orders = [order()]; mock.command.mockResolvedValueOnce({ results: [] });
    const view = show();
    expect(screen.queryByRole('button', { name: '삼성전자 전체 취소' })).not.toBeInTheDocument();
    fireEvent.keyDown(view.getByTestId('order-window'), { key: 'Backspace', ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: '취소 접수' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][0]).toBe('/cancel-all');
  });

  it('10호가창의 총잔량 스트립을 공유하고 숫자·비율 바만 표시한다', () => {
    show();
    const strip = screen.getByTestId('book-total-strip');
    expect(strip).toHaveTextContent('1,0002,000');
    expect(screen.getByLabelText('매도총잔량 1,000')).toHaveTextContent('1,000');
    expect(screen.getByLabelText('매수총잔량 2,000')).toHaveTextContent('2,000');
    expect(screen.getByTestId('book-total-fill')).toHaveStyle({ gridTemplateColumns: '1000fr 2000fr' });
    expect(strip).not.toHaveTextContent('매도 잔량'); expect(strip).not.toHaveTextContent('매수 잔량');
  });

  it('개별 주문 편집 중 Esc는 창 복원 이벤트로 전파하지 않는다', () => {
    mock.orders = [order()]; show();
    const onGlobalEscape = vi.fn(); window.addEventListener('keydown', onGlobalEscape);
    try {
      const chip = screen.getByRole('button', { name: '매수 67,200원 1건 상세 정정' });
      fireEvent.click(chip);
      fireEvent.keyDown(chip, { key: 'Escape' });
      expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
      expect(onGlobalEscape).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', onGlobalEscape); }
  });

});
