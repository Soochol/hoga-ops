import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TossOrder } from '../../api/trading';
import { OrderWindow } from './OrderWindow';
import { DataWindow } from './DataWindow';
import type { WorkspaceWindow } from '../../state/workspace';
import { groupPriceOrders, holdingBookMarker, holdingProfitPercent, holdingProfitWon, holdingPurchaseAmountWon, orderRemainder } from './orderRules';
import { useLiveVenueStore, type LiveVenueOption } from '../../state/liveVenue';
import { useLiveSeries } from '../../api/liveSeries';
import { useQuoteByCode } from '../../api/liveQuotes';
import { useLiveViStatus } from '../../api/liveViStatus';
import { notifyOrderReceiptAccepted, playOrderReceiptSound, prepareOrderReceiptSound, subscribeOrderReceiptSoundRecovery } from './orderReceiptSound';
import type { LiveAfterHoursBookResponse } from '../../api/liveAfterHoursBook';
import { normalizeOrderSettings } from '../../state/orderWindowSettings';

vi.mock('./orderReceiptSound', () => ({
  notifyOrderReceiptAccepted: vi.fn(), playOrderReceiptSound: vi.fn(), prepareOrderReceiptSound: vi.fn(),
  subscribeOrderReceiptSoundRecovery: vi.fn(),
}));

const mock = vi.hoisted(() => ({ configured: true, accountsLoading: false, accountError: null as Error | null, stateError: null as Error | null, unresolved: [] as string[], balancesError: false, accountCount: 1, holdingQuantity: '100', sellableQuantity: '80' as string | undefined, priceOffset: 0, quotePrice: 67200 as number | null, buyingPower: '50000000', averagePrice: '66000', now: 1791856800000, snapshotAt: 1791856800000, expectedPrice: 0, expectedQty: 0 as number | null, askCount: 10, bidCount: 10, orders: [] as TossOrder[], command: vi.fn() }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
afterAll(() => vi.unstubAllGlobals());
vi.mock('../../api/trading', () => ({
  useTradingAccounts: () => ({ data: { configured: mock.configured, accounts: mock.configured ? Array.from({ length: mock.accountCount }, (_, index) => ({ account_seq: index + 1, label: `계좌 ${index + 1}` })) : [] }, isLoading: mock.accountsLoading, error: mock.accountError }),
  useTradingState: () => ({ isError: !!mock.stateError, error: mock.stateError, balancesError: mock.balancesError, data: mock.configured ? { account_seq: 1, code: '005930', orders: mock.orders, recent_orders: [], buying_power: mock.buyingPower, sellable_quantity: mock.sellableQuantity, holding_quantity: mock.holdingQuantity, average_purchase_price: mock.averagePrice, fetched_at_ms: mock.now, events_connected: true, unresolved_commands: mock.unresolved } : undefined }),
  useTradingAccountList: () => ({ orders: { data: undefined }, holdings: { data: undefined }, paused: false }),
  tradingCommand: (...args: unknown[]) => mock.command(...args),
}));
vi.mock('../../api/liveSeries', () => ({ useLiveSeries: vi.fn(() => ({ ob: [], latestOb: { t_ms: mock.snapshotAt, asks: Array.from({ length: 10 }, (_, i) => i < mock.askCount ? { price: 67300 + mock.priceOffset + i * 100, qty: 100 + i } : { price: 0, qty: 0 }), bids: Array.from({ length: 10 }, (_, i) => i < mock.bidCount ? { price: 67200 + mock.priceOffset - i * 100, qty: 200 + i } : { price: 0, qty: 0 }), total_ask_qty: 1000, total_bid_qty: 2000, expected_price: mock.expectedPrice, expected_qty: mock.expectedQty }, trade: [], afterHours: [] })) }));
vi.mock('../../api/liveQuotes', () => ({ useQuoteByCode: vi.fn(() => new Map([['005930', { price: mock.quotePrice, baseline_price: 66000, open: 68000, high: 69000, low: 67000, volume: 8336637, trade_value: 12290807000000, vs_prev_volume_pct: 184.55, expected_price: mock.expectedPrice, expected_qty: mock.expectedQty }]])) }));
vi.mock('../../api/liveStockLimits', () => ({ useLiveStockLimits: () => ({ data: { base_price: 66000, upper_limit: 85800, lower_limit: 46200, high_250: 70000, low_250: 50000 } }) }));
vi.mock('../../api/liveKrxClose', () => ({ useLiveKrxClose: () => ({ data: { date: '20261013', price: 67100 } }) }));
vi.mock('../../api/liveKrxPreviousClose', () => ({ useLiveKrxPreviousClose: (code: string | null, asOf: string) => (
  { data: code ? { code, as_of: asOf, session_date: asOf, date: '20261012', price: 65000 } : undefined }
) }));
vi.mock('../../api/liveViStatus', () => ({ useLiveViStatus: vi.fn(() => ({ data: { vi: null } })) }));
vi.mock('../../util/useWallClockSecond', () => ({ useWallClockSecond: () => mock.now }));
vi.mock('../useMinuteClock', () => ({ useMinuteClock: () => mock.now }));
const symbolMaster = vi.hoisted(() => ({ nxtEnabled: true as boolean | null }));
const afterHoursBook = vi.hoisted(() => ({ data: undefined as LiveAfterHoursBookResponse | undefined }));
vi.mock('../../capture/useSymbols', () => ({ useSymbols: () => ({ data: { symbols: [{ code: '005930', nxt_enabled: symbolMaster.nxtEnabled }] } }) }));
vi.mock('../../api/liveAfterHoursBook', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/liveAfterHoursBook')>(), useAfterHoursBook: () => afterHoursBook,
}));
vi.mock('../../api/useLiveCursor', () => ({ useLiveOrderbookAtCursor: () => ({ spot: undefined, stale: false, error: null }) }));
vi.mock('../../api/screenerDailyCandles', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/screenerDailyCandles')>(), useScreenerDailyCandles: () => ({ data: undefined }),
}));

function order(id = 'a'): TossOrder {
  return { orderId: id, symbol: '005930', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', status: 'PARTIAL_FILLED', price: '67200', quantity: '100', orderAmount: null, currency: 'KRW', orderedAt: '', canceledAt: null,
    execution: { filledQuantity: '30', averageFilledPrice: '67200', filledAmount: '2016000', commission: null, tax: null, filledAt: null, settlementDate: null } };
}
function show() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>); }
function enableReceiptSound() {
  fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));

  fireEvent.click(screen.getByRole('switch', { name: '주문접수 소리' }));
  fireEvent.click(screen.getByRole('button', { name: '주문 설정 닫기' }));
}
beforeEach(() => {
  afterHoursBook.data = undefined;
  mock.accountsLoading = false; mock.accountError = null; mock.stateError = null; mock.unresolved = [];
  vi.mocked(notifyOrderReceiptAccepted).mockReset().mockResolvedValue(true);
  vi.mocked(prepareOrderReceiptSound).mockReset();
  vi.mocked(playOrderReceiptSound).mockReset().mockResolvedValue(true);
  vi.mocked(subscribeOrderReceiptSoundRecovery).mockReset().mockReturnValue(() => {});
});
beforeEach(() => { mock.sellableQuantity = '80'; mock.holdingQuantity = '100'; mock.orders = []; mock.configured = true; mock.balancesError = false; mock.accountCount = 1; mock.priceOffset = 0; mock.quotePrice = 67200; mock.buyingPower = '50000000'; mock.averagePrice = '66000'; mock.snapshotAt = mock.now; mock.expectedPrice = 0; mock.expectedQty = 0; mock.askCount = 10; mock.bidCount = 10; mock.command.mockReset().mockResolvedValue({ command_id: 'a', order_id: 'new', status: 'accepted' }); symbolMaster.nxtEnabled = true; useLiveVenueStore.setState({ venue: 'KRX' }); vi.mocked(useLiveSeries).mockClear(); vi.mocked(useQuoteByCode).mockClear(); vi.mocked(useLiveViStatus).mockClear(); });

describe('호가 주문', () => {
  it('호가 지연 사유는 상단에 표시하지 않고 주문 시도에서 토스트로 안내하며 API를 호출하지 않는다', () => {
    mock.snapshotAt = mock.now - 60_000;
    show();
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: '주문 알림' })).not.toBeInTheDocument();
    const buy = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    expect(buy).not.toHaveAttribute('aria-describedby');
    fireEvent.doubleClick(buy);
    fireEvent.doubleClick(buy);
    expect(screen.getAllByRole('alert', { name: '주문 알림' })).toHaveLength(1);
    expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent('최신 호가를 기다리고 있습니다');
    expect(mock.command).not.toHaveBeenCalled();
    mock.snapshotAt = mock.now;
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '25' } });
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    expect(buy).toHaveAttribute('aria-disabled', 'false');
  });

  it.each(['', '0', '1.5', '1000000001'])('잘못된 수량 %s는 입력 중 안내하지 않고 마우스·키보드 주문 시도에서만 검증한다', value => {
    show();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value } });
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: '주문 알림' })).not.toBeInTheDocument();
    const buy = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    for (const attempt of [() => fireEvent.doubleClick(buy), () => fireEvent.keyDown(buy, { key: 'Enter' }), () => fireEvent.keyDown(buy, { key: ' ' })]) {
      attempt();
      expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent('주문 수량은 1주 이상 10억주 이하의 정수로 입력하세요.');
      fireEvent.click(screen.getByRole('button', { name: '주문 알림 닫기' }));
    }
    expect(mock.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '7' } });
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: '주문 알림' })).not.toBeInTheDocument();
    expect(buy).toHaveAttribute('aria-disabled', 'false');
  });

  it.each(['loading', 'unconfigured', 'account-error', 'state-error', 'unknown-result'] as const)('%s에서 주문 차단 사유는 하단 상태줄로 안내한다', reason => {
    mock.accountsLoading = reason === 'loading';
    mock.configured = reason !== 'unconfigured';
    mock.accountError = reason === 'account-error' ? new Error('계좌 인증에 실패했습니다') : null;
    mock.stateError = reason === 'state-error' ? new Error('주문 내역을 조회할 수 없습니다') : null;
    mock.unresolved = reason === 'unknown-result' ? ['unknown-command'] : [];
    show();
    const text = { loading: '계좌 확인 중', unconfigured: '계좌 연결 필요', 'account-error': '계좌 인증에 실패했습니다',
      'state-error': '주문 내역을 조회할 수 없습니다', 'unknown-result': '주문 결과 확인 필요' }[reason]!;
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    if (reason === 'unknown-result') expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent(text);
    else expect(screen.queryByRole('alert', { name: '주문 알림' })).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent(text);
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    expect(mock.command).not.toHaveBeenCalled();
  });

  it.each([
    ['order-hours-closed', '현재 해당 주문을 접수할 수 없는 시간입니다.'],
    ['insufficient-buying-power', '주문 가능 금액이 부족합니다.'],
  ])('API 확정 거절 %s는 제목·사유를 나누고 같은 요청 재확인 버튼을 만들지 않는다', async (code, message) => {
    mock.command.mockRejectedValueOnce(Object.assign(new Error(message), { code, status: 422 }));
    show();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    const toast = await screen.findByRole('alert', { name: '주문 알림' });
    expect(within(toast).getByText('주문 접수 불가')).toBeInTheDocument();
    expect(within(toast).getByText(message)).toBeInTheDocument();
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '같은 요청 다시 확인' })).not.toBeInTheDocument();
    expect(notifyOrderReceiptAccepted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '주문 알림 닫기' }));
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '25' } });
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
  });

  it('고액 확인창이 열린 뒤 호가가 오래돼도 전송 직전에 같은 사유로 차단한다', () => {
    show();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '2000' } });
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    mock.snapshotAt = mock.now - 60_000;
    fireEvent.click(screen.getByRole('checkbox', { name: '1억원 이상 주문 금액을 확인했습니다' }));
    fireEvent.click(screen.getByRole('button', { name: '확인 후 주문' }));
    expect(mock.command).not.toHaveBeenCalled();
    expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent('최신 호가');
  });

  it('계좌를 바꾸면 이전 계좌의 거절 토스트를 해제한다', async () => {
    mock.accountCount = 2;
    mock.command.mockRejectedValueOnce(Object.assign(new Error('주문 접수 시간이 아닙니다'), { code: 'order-hours-closed', status: 422 }));
    show();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await screen.findByRole('alert', { name: '주문 알림' });
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '주문 계좌' }), { target: { value: '2' } });
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: '주문 알림' })).not.toBeInTheDocument();
    expect(mock.command).toHaveBeenCalledOnce();
  });

  it.each(['cancel-rejected', 'order-outcome-unknown'])('일괄 취소의 부분 실패 %s도 사유를 안내하며 성공한 요청을 재전송하지 않는다', async code => {
    mock.orders = [order()];
    mock.command.mockResolvedValueOnce({ results: [{ order_id: 'a', accepted: false, code, message: '취소 결과를 확인하세요' }] });
    const view = show();
    fireEvent.contextMenu(view.container.querySelector('.order-ladder')!);
    fireEvent.click(screen.getByRole('menuitem', { name: '전체 주문 취소' }));
    const toast = await screen.findByRole('alert', { name: '주문 알림' });
    expect(toast).toHaveTextContent(code === 'order-outcome-unknown' ? '취소 결과 확인 필요' : '취소 접수 불가');
    expect(toast).toHaveTextContent('취소 미접수 1건');
    expect(toast.querySelector('.toast-progress')).toBeNull();
    expect(screen.queryByRole('button', { name: '같은 요청 다시 확인' })).not.toBeInTheDocument();
    expect(mock.command).toHaveBeenCalledOnce();
  });

  it('결과 불명확 알림은 자동으로 닫지 않고 자신의 요청 ID로만 다시 확인한다', async () => {
    vi.useFakeTimers();
    try {
      mock.command.mockRejectedValueOnce(Object.assign(new Error('실제 접수 여부를 확인하세요'), { code: 'order-outcome-unknown', status: 503 }));
      const client = new QueryClient();
      const content = () => <QueryClientProvider client={client}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>;
      const view = render(content());
      fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
      await act(async () => {});
      const commandId = mock.command.mock.calls[0][1].command_id;
      mock.unresolved = [commandId];
      view.rerender(content());
      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent('주문 결과 확인 필요');
      expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
      fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
      expect(mock.command).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole('button', { name: '내역 확인' }));
      fireEvent.click(screen.getByRole('button', { name: '같은 요청 다시 확인' }));
      await act(async () => {});
      expect(mock.command).toHaveBeenCalledTimes(2);
      expect(mock.command.mock.calls[1]).toEqual(mock.command.mock.calls[0]);
      expect(screen.getByRole('status', { name: '주문 접수 알림' })).toHaveTextContent('주문 요청 접수됨');
    } finally { vi.useRealTimers(); }
  });

  it('결과 불명확 확인 절차는 상태줄 상세에서만 열고 확인 기록 후에도 상태줄을 유지한다', async () => {
    mock.unresolved = ['unknown-command'];
    const view = show();
    const bar = screen.getByTestId('order-status-bar');
    expect(bar).toHaveTextContent('결과가 불명확한 요청');
    expect(view.container.querySelector('.order-editor')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '해당 증권사의 실제 주문·체결 여부를 확인했습니다' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '내역 확인' }));
    const details = screen.getByRole('dialog', { name: '주문 알림 상세' });
    const confirm = within(details).getByRole('button', { name: '요청 unknown- 확인 완료' });
    expect(confirm).toBeDisabled();
    fireEvent.click(within(details).getByRole('checkbox', { name: '해당 증권사의 실제 주문·체결 여부를 확인했습니다' }));
    fireEvent.click(confirm);
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command).toHaveBeenCalledWith('/commands/unknown-command/review', expect.objectContaining({ command_id: 'unknown-command', confirmed: true }), 'live');
    fireEvent.click(within(details).getByRole('button', { name: '주문 알림 상세 닫기' }));
    expect(screen.getByTestId('order-status-bar')).toBe(bar);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['67,300', '0.07억'],
    ['67,200', '0.13억'],
  ])('주문창 가격 %s의 툴팁은 공통 주문수량 대신 시장 잔량 금액을 표시한다', (price, text) => {
    vi.useFakeTimers();
    try {
      show();
      fireEvent.change(screen.getByRole('spinbutton', { name: '신규 주문 수량' }), { target: { value: '3' } });
      const value = screen.getByText(price, { selector: '.order-price .book-price-amount' });
      vi.spyOn(value, 'matches').mockImplementation(selector => selector === ':hover');
      fireEvent.mouseEnter(value);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole('tooltip')).toHaveTextContent(text);
      expect(screen.getByRole('tooltip')).toHaveClass('order-tooltip');
      fireEvent.mouseLeave(value);
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(mock.command).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(['BUY', 'SELL'] as const)('반대 방향 미체결이 있어도 %s 주문을 전송한다', async side => {
    mock.orders = [{ ...order(), side: side === 'BUY' ? 'SELL' : 'BUY' }];
    show();
    const label = side === 'BUY' ? /매수 67,200원 주문 추가/ : /매도 67,300원 주문 추가/;
    const lane = screen.getByRole('button', { name: label });
    expect(lane).toBeEnabled();
    fireEvent.doubleClick(lane);
    await screen.findByText('주문 요청 접수됨');
    expect(mock.command).toHaveBeenCalledExactlyOnceWith('/orders', expect.objectContaining({
      side, price: side === 'BUY' ? 67200 : 67300, quantity: 10,
    }), expect.any(String));
  });
  it('반대 방향 주문을 전송한 후 서버 거절 메시지를 표시한다', async () => {
    mock.orders = [{ ...order(), side: 'SELL' }];
    mock.command.mockRejectedValueOnce(new Error('동일 종목에 반대 방향의 체결 대기 주문이 있습니다.'));
    show();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await screen.findByText('동일 종목에 반대 방향의 체결 대기 주문이 있습니다.');
    expect(mock.command).toHaveBeenCalledOnce();
    expect(screen.queryByText('주문 요청 접수됨')).not.toBeInTheDocument();
  });
  it('켜진 주문창만 화면 복귀 복구를 구독하고 끄기·닫기에서 해제한다', () => {
    const cleanup = vi.fn();
    vi.mocked(subscribeOrderReceiptSoundRecovery).mockReturnValue(cleanup);
    const view = show();
    expect(subscribeOrderReceiptSoundRecovery).not.toHaveBeenCalled();
    enableReceiptSound();
    expect(subscribeOrderReceiptSoundRecovery).toHaveBeenCalledOnce();
    enableReceiptSound(); // Toggle off and apply.
    expect(cleanup).toHaveBeenCalledOnce();
    enableReceiptSound();
    view.unmount();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it.each([false, 'reject'])('오디오 실패 %s는 접수 성공을 유지하며 주문 재확인을 만들지 않는다', async result => {
    if (result === 'reject') vi.mocked(notifyOrderReceiptAccepted).mockRejectedValue(new Error('audio unavailable'));
    else vi.mocked(notifyOrderReceiptAccepted).mockResolvedValue(false);
    show(); enableReceiptSound();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await screen.findByText('주문은 접수됐지만 알림음을 재생하지 못했습니다');
    expect(screen.getByRole('status', { name: '주문 접수 알림' })).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: '주문 알림' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '같은 요청 다시 확인' })).not.toBeInTheDocument();
    expect(mock.command).toHaveBeenCalledOnce();
  });
  it('이전 접수음의 늦은 실패가 다음 주문의 접수 알림을 덮어쓰지 않는다', async () => {
    let failFirst!: (started: boolean) => void;
    vi.mocked(notifyOrderReceiptAccepted).mockReturnValueOnce(new Promise(resolve => { failFirst = resolve; }));
    show(); enableReceiptSound();
    const buy = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    fireEvent.doubleClick(buy);
    await screen.findByText('주문 요청 접수됨');
    fireEvent.doubleClick(buy);
    await waitFor(() => expect(notifyOrderReceiptAccepted).toHaveBeenCalledTimes(2));
    await act(async () => failFirst(false));
    expect(screen.getByRole('status', { name: '주문 접수 알림' })).toHaveTextContent('주문 요청 접수됨');
  });
  it('시간외 단일가에서도 두 창의 툴팁은 당일 종가 대신 직전 KRX 종가를 쓴다', async () => {
    symbolMaster.nxtEnabled = false;
    // A stored single-price ladder exercises the same baseline switch outside trading hours.
    afterHoursBook.data = { code: '005930', active: true, base_tm: '170000',
      ask: [{ price: 67300, qty: 100 }], bid: [{ price: 67200, qty: 200 }],
      total_ask_qty: 100, total_bid_qty: 200, cur_price: 67200, change_pct: 0,
      acc_volume: 1, close_price: 68000, exp_price: null, exp_qty: null, fills: [],
      fetched_at_ms: mock.now, source: 'stored' };
    const win: WorkspaceWindow = { id: 'book', kind: 'book', group: 1, rect: { x: 0, y: 0, w: 560, h: 640 } };
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div data-testid="compare-book"><DataWindow win={win} symbol={{ code: '005930', name: '삼성전자' }} /></div>
      <OrderWindow code="005930" name="삼성전자" />
    </QueryClientProvider>);
    const bookButton = within(screen.getByTestId('compare-book')).getByRole('button', { name: '종목 상세 정보' });
    fireEvent.click(bookButton);
    let dialog = screen.getByRole('dialog', { name: '종목 상세 정보' });
    let value = within(dialog).getByLabelText('시작 가격 68,000원');
    fireEvent.mouseEnter(value);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('전일 KRX 종가 대비 +4.62%');
    fireEvent.mouseLeave(value);
    fireEvent.click(within(dialog).getByRole('button', { name: '상세 정보 닫기' }));
    fireEvent.click(within(screen.getByTestId('order-window')).getByRole('button', { name: '종목 상세 정보' }));
    dialog = screen.getByRole('dialog', { name: '종목 상세 정보' });
    value = within(dialog).getByLabelText('시작 가격 68,000원');
    fireEvent.mouseEnter(value);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('전일 KRX 종가 대비 +4.62%');
    fireEvent.mouseLeave(value);
  });
  it('상세정보의 시고저 툴팁은 시세 기준가 대신 전일 KRX 종가를 쓴다', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '종목 상세 정보' }));
    const dialog = screen.getByRole('dialog', { name: '종목 상세 정보' });
    const value = within(dialog).getByLabelText('시작 가격 68,000원');
    fireEvent.mouseEnter(value);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('전일 KRX 종가 대비 +4.62%');
    fireEvent.mouseLeave(value);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
  it('소리 들어보기는 설정을 바꾸지 않고 소리 토글은 즉시 저장한다', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));

    const checkbox = screen.getByRole('switch', { name: '주문접수 소리' });
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '소리 들어보기' }));
    await waitFor(() => expect(playOrderReceiptSound).toHaveBeenCalledOnce());
    expect(checkbox).not.toBeChecked();
    expect(mock.command).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: '주문 설정 닫기' }));
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));

    expect(screen.getByRole('switch', { name: '주문접수 소리' })).toBeChecked();
  });
  it('미리듣기 차단을 설정 안에서 안내한다', async () => {
    vi.mocked(playOrderReceiptSound).mockResolvedValue(false);
    show();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));

    fireEvent.click(screen.getByRole('button', { name: '소리 들어보기' }));
    await screen.findByText('소리를 재생할 수 없습니다. 브라우저의 소리 설정을 확인하세요.');
    expect(mock.command).not.toHaveBeenCalled();
  });
  it.each(['매수 67,200원 주문 추가', '매도 67,300원 주문 추가'])('%s는 전송 중에는 울리지 않고 성공 응답에서만 알린다', async label => {
    let resolve!: (response: object) => void;
    mock.command.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    show(); enableReceiptSound();
    vi.mocked(prepareOrderReceiptSound).mockClear();
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole('button', { name: new RegExp(label) }));
    expect(prepareOrderReceiptSound).toHaveBeenCalledOnce();
    expect(notifyOrderReceiptAccepted).not.toHaveBeenCalled();
    expect(screen.queryByRole('status', { name: '주문 접수 알림' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(label) })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.doubleClick(screen.getByRole('button', { name: new RegExp(label) }));
    fireEvent.keyDown(screen.getByRole('button', { name: new RegExp(label) }), { key: 'Enter' });
    expect(mock.command).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert', { name: '주문 알림' })).not.toBeInTheDocument();
    await act(async () => resolve({ command_id: mock.command.mock.calls[0][1].command_id, order_id: 'new', status: 'accepted' }));
    expect(notifyOrderReceiptAccepted).toHaveBeenCalledExactlyOnceWith(1, mock.command.mock.calls[0][1].command_id);
    expect(screen.getByRole('status', { name: '주문 접수 알림' })).toHaveTextContent('주문 요청 접수됨');
    expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
  });
  it('소리 끄기는 접수 성공에도 오디오를 준비하거나 재생하지 않는다', async () => {
    show();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await screen.findByText('주문 요청 접수됨');
    expect(prepareOrderReceiptSound).not.toHaveBeenCalled();
    expect(notifyOrderReceiptAccepted).not.toHaveBeenCalled();
  });
  it('소리를 켜도 결과 불명확은 울리지 않고 같은 요청 확인 후 접수되면 알린다', async () => {
    mock.command.mockRejectedValueOnce(new Error('주문 처리 결과 확인 필요'));
    show(); enableReceiptSound();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await screen.findByText('주문 처리 결과 확인 필요');
    expect(notifyOrderReceiptAccepted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '내역 확인' }));
    fireEvent.click(screen.getByRole('button', { name: '같은 요청 다시 확인' }));
    await screen.findByText('주문 요청 접수됨');
    expect(mock.command.mock.calls[1]).toEqual(mock.command.mock.calls[0]);
    expect(notifyOrderReceiptAccepted).toHaveBeenCalledExactlyOnceWith(1, mock.command.mock.calls[0][1].command_id);
  });
  it('소리를 켜도 취소 접수는 신규 주문 소리를 내지 않는다', async () => {
    mock.orders = [order()];
    mock.command.mockResolvedValueOnce({ results: [{ order_id: 'a', accepted: true, operation_id: 'cancel-a' }] });
    const view = show(); enableReceiptSound();
    fireEvent.contextMenu(view.container.querySelector('.order-ladder')!, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: '전체 주문 취소' }));
    await screen.findByText('취소 요청 접수됨');
    expect(notifyOrderReceiptAccepted).not.toHaveBeenCalled();
  });
  it('원본 소수 평단가로 최근접 호가를 고르고 동률이면 낮은 호가를 고른다', () => {
    const prices = [67300, 67200, 0, NaN];
    expect(holdingBookMarker(100, '67240.5', prices)).toEqual({ price: 67200, outside: false });
    expect(holdingBookMarker(100, '67250', prices)).toEqual({ price: 67200, outside: false });
    expect(holdingBookMarker(100, '67250.00000000000000001', prices)).toEqual({ price: 67300, outside: false });
    expect(holdingBookMarker(100, '67200', prices)).toEqual({ price: 67200, outside: false });
    expect(holdingBookMarker(100, '67300', prices)).toEqual({ price: 67300, outside: false });
  });
  it.each([
    ['67240.5', 67200],
    ['67300', 67200],
    ['67300.00000000000000001', null],
    ['67400', null],
    ['67499.99999999999999999', null],
    ['67500', 67600],
  ])('빈 호가 구간의 평단가 %s는 최근접 호가에서 1틱 이내일 때만 표시한다', (average, price) => {
    expect(holdingBookMarker(100, average, [67600, 67200])).toEqual({ price, outside: false });
  });
  it.each([
    [2000, 1, 5], [5000, 5, 10], [20000, 10, 50],
    [50000, 50, 100], [200000, 100, 500], [500000, 500, 1000],
  ])('%i원 가격대 경계는 평단가 방향의 1틱을 적용한다', (boundary, lowerTick, upperTick) => {
    const lowerPrices = [boundary, boundary - 4 * lowerTick];
    const upperPrices = [boundary + 4 * upperTick, boundary];
    expect(holdingBookMarker(3, String(boundary - lowerTick), lowerPrices)).toEqual({ price: boundary, outside: false });
    expect(holdingBookMarker(3, String(boundary - lowerTick - 0.1), lowerPrices)).toEqual({ price: null, outside: false });
    expect(holdingBookMarker(3, String(boundary + upperTick), upperPrices)).toEqual({ price: boundary, outside: false });
    expect(holdingBookMarker(3, String(boundary + upperTick + 0.1), upperPrices)).toEqual({ price: null, outside: false });
  });
  it('평단가가 표시 호가에서 1틱을 넘으면 원만 숨기고 상단 평단가는 유지한다', () => {
    const originalSeries = vi.mocked(useLiveSeries).getMockImplementation()!;
    vi.mocked(useLiveSeries).mockImplementation((...args) => ({ ...originalSeries(...args),
      latestOb: { t_ms: mock.snapshotAt, asks: [{ price: 67600, qty: 100 }], bids: [{ price: 67200, qty: 200 }],
        total_ask_qty: 100, total_bid_qty: 200 },
    }));
    try {
      const client = new QueryClient();
      const content = () => <QueryClientProvider client={client}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>;
      mock.averagePrice = '67400';
      const view = render(content());
      expect(view.container.querySelector('.order-average-marker')).toBeNull();
      expect(screen.getByLabelText('매입평단가')).toHaveTextContent('67,400');
      for (const [average, price] of [['67300', '67200'], ['67500', '67600']] as const) {
        mock.averagePrice = average;
        view.rerender(content());
        expect(view.container.querySelector('.order-average-marker')?.closest('.order-row')).toHaveAttribute('data-order-price', price);
      }
      mock.averagePrice = '67400';
      view.rerender(content());
      expect(view.container.querySelector('.order-average-marker')).toBeNull();
      expect(screen.getByLabelText('매입평단가')).toHaveTextContent('67,400');
      expect(mock.command).not.toHaveBeenCalled();
    } finally {
      vi.mocked(useLiveSeries).mockImplementation(originalSeries);
    }
  });
  it('범위 밖 평단가와 미보유·잘못된 평단가·빈 호가를 구분한다', () => {
    expect(holdingBookMarker(100, '67199.99999999999999999', [67300, 67200])).toEqual({ price: null, outside: true });
    expect(holdingBookMarker(100, '67300.1', [67300, 67200])).toEqual({ price: null, outside: true });
    for (const average of [null, '', '0', '-1', 'NaN', 'Infinity']) {
      expect(holdingBookMarker(100, average, [67300, 67200])).toEqual({ price: null, outside: false });
    }
    for (const quantity of [null, 0, -1, NaN]) {
      expect(holdingBookMarker(quantity, '67200', [67300, 67200])).toEqual({ price: null, outside: false });
    }
    expect(holdingBookMarker(100, '67200', [0, NaN])).toEqual({ price: null, outside: false });
    expect(holdingBookMarker(100, '67200', [])).toEqual({ price: null, outside: false });
  });
  it('평단가 원과 저가 배지를 같은 가격에 함께 표시하고 정확한 원본 평단가를 설명한다', () => {
    mock.averagePrice = '67000.1';
    const { container } = show();
    const marker = screen.getByRole('img', { name: '내 평단가 67,000.1원 · 가장 가까운 호가 67,000원' });
    const value = container.querySelector('[data-order-price="67000"] .order-price-value')!;
    expect(value).toContainElement(marker);
    expect(value.querySelector('[data-price-badges]')).toHaveTextContent('저');
    expect(marker).toHaveAttribute('title', '내 평단가 67,000.1원 · 가장 가까운 호가 67,000원');
    expect(container.querySelectorAll('.order-average-marker')).toHaveLength(1);
    expect(mock.command).not.toHaveBeenCalled();
  });
  it.each(['67200', '67200.000'])('평단가 %s와 호가가 일치하면 내 평단가로 설명한다', average => {
    mock.averagePrice = average;
    const { container } = show();
    expect(screen.getByRole('img', { name: `내 평단가 ${average === '67200' ? '67,200' : '67,200.000'}원` })
      .closest('.order-row')).toHaveAttribute('data-order-price', '67200');
    expect(container.querySelectorAll('.order-average-marker')).toHaveLength(1);
  });
  it('범위 밖 평단가는 끝 행에 표시하지 않고 별도 안내도 추가하지 않는다', () => {
    const { container } = show();
    expect(container.querySelector('.order-average-marker')).toBeNull();
    expect(screen.getByLabelText('매입평단가')).not.toHaveTextContent('호가 범위 밖');
  });
  it('미보유면 평단가 원과 범위 밖 안내를 숨긴다', () => {
    mock.holdingQuantity = '0'; mock.averagePrice = '67200';
    const { container } = show();
    expect(container.querySelector('.order-average-marker')).toBeNull();
    expect(screen.queryByText('호가 범위 밖')).not.toBeInTheDocument();
  });
  it('잔고 조회 실패 시 남아 있는 평단가 데이터로 원을 표시하지 않는다', () => {
    mock.averagePrice = '67200'; mock.balancesError = true;
    const { container } = show();
    expect(container.querySelector('.order-average-marker')).toBeNull();
    expect(screen.queryByText('호가 범위 밖')).not.toBeInTheDocument();
  });
  it('계좌 전환 시 새 평단가로 원을 이동하고 호가가 범위를 벗어나면 숨긴다', () => {
    mock.accountCount = 2; mock.averagePrice = '67240.5';
    const { container } = show();
    expect(container.querySelector('.order-average-marker')?.closest('.order-row')).toHaveAttribute('data-order-price', '67200');
    mock.averagePrice = '67540.5';
    fireEvent.change(screen.getByRole('combobox', { name: '주문 계좌' }), { target: { value: '2' } });
    expect(container.querySelector('.order-average-marker')?.closest('.order-row')).toHaveAttribute('data-order-price', '67500');
    mock.priceOffset = 3000;
    act(() => useLiveVenueStore.setState({ venue: 'NXT' }));
    expect(container.querySelector('.order-average-marker')).toBeNull();
    expect(screen.getByLabelText('매입평단가')).not.toHaveTextContent('호가 범위 밖');
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('예상 체결가·체결량을 상단 배너 대신 정보 1페이지에서 갱신한다', () => {
    mock.expectedPrice = 241_000; mock.expectedQty = 6_140;
    const view = show();
    expect(screen.queryByTestId('book-expected-fill')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '종목 상세 정보' }));
    const banner = screen.getByTestId('book-expected-fill');
    expect(banner).toHaveTextContent('예상 체결가241,000원');
    expect(banner).toHaveTextContent('예상 체결량6,140');
    expect(banner.closest('[data-testid="book-summary"]')).toHaveAttribute('data-page', '1');
    expect(screen.getByTestId('order-window').querySelector(':scope > .book-expected-fill')).toBeNull();
    expect(screen.getByText('시작')).toBeInTheDocument();
    mock.expectedQty = 0;
    view.rerender(<QueryClientProvider client={new QueryClient()}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>);
    expect(screen.getByTestId('book-expected-fill')).toHaveTextContent(/^예상 체결가예상 체결량$/);
  });
  it('예상 체결값이 없어도 정보 2페이지의 다른 항목은 유지한다', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '종목 상세 정보' }));
    fireEvent.click(screen.getByTestId('book-summary'));
    expect(screen.queryByTestId('book-expected-fill')).not.toBeInTheDocument();
    expect(screen.getByText('상한가')).toBeInTheDocument();
  });
  it('호가에 예상값이 없는 장중에도 0H 오버레이를 두 창에 표시하고 종료 시 지운다', () => {
    const originalSeries = vi.mocked(useLiveSeries).getMockImplementation()!;
    vi.mocked(useLiveSeries).mockImplementation((...args) => {
      const live = originalSeries(...args);
      return { ...live, latestOb: live.latestOb ? { ...live.latestOb, expected_price: 0, expected_qty: 0 } : undefined };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const win: WorkspaceWindow = { id: 'book', kind: 'book', group: 1, rect: { x: 0, y: 0, w: 560, h: 640 } };
    const content = () => <QueryClientProvider client={client}>
      <DataWindow win={win} symbol={{ code: '005930', name: '삼성전자' }} />
      <OrderWindow code="005930" name="삼성전자" />
    </QueryClientProvider>;
    try {
      mock.expectedPrice = 121100; mock.expectedQty = null;
      const view = render(content());
      fireEvent.click(within(screen.getByTestId('order-window')).getByRole('button', { name: '종목 상세 정보' }));
      const banners = screen.getAllByTestId('book-expected-fill');
      expect(banners).toHaveLength(2);
      banners.forEach(banner => {
        expect(banner).toHaveTextContent(/^예상 체결가121,100원예상 체결량$/);
      });
      mock.expectedPrice = 0; mock.expectedQty = 0;
      view.rerender(content());
      screen.getAllByTestId('book-expected-fill').forEach(banner => {
        expect(banner).toHaveTextContent(/^예상 체결가예상 체결량$/);
      });
      expect(mock.command).not.toHaveBeenCalled();
    } finally {
      vi.mocked(useLiveSeries).mockImplementation(originalSeries);
    }
  });
  it('부분 호가는 빈 공간을 유지하고 실제 가격에만 주문을 허용한다', () => {
    mock.askCount = 4; mock.bidCount = 3;
    const { container } = show();
    const rows = container.querySelectorAll('[data-order-price]');
    expect(Array.from(rows).map(row => row.getAttribute('data-order-price'))).toEqual(['67600', '67500', '67400', '67300', '67200', '67100', '67000']);
    expect(container.querySelectorAll('.order-ask')).toHaveLength(4);
    expect(container.querySelectorAll('.order-bid')).toHaveLength(3);
    expect(container.querySelector('.order-divider')).toBe(rows[4]);
    expect(rows[4]).toHaveTextContent('체결강도');
    expect(container.querySelector('[data-order-price="0"]')).toBeNull();
    const slots = container.querySelectorAll('.order-row');
    expect(slots).toHaveLength(20);
    expect(slots[9]).toBe(rows[3]);
    expect(slots[10]).toBe(rows[4]);
    expect(container.querySelectorAll('.order-empty')).toHaveLength(13);
    expect(container.querySelector('.order-empty button')).toBeNull();
    expect(container.querySelector('.order-empty [data-order-side]')).toBeNull();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it.each([[0, 3], [3, 0], [10, 10]])('매도 %i단·매수 %i단에서도 경계와 체결강도의 위치를 유지한다', (askCount, bidCount) => {
    mock.askCount = askCount; mock.bidCount = bidCount;
    const { container } = show();
    const slots = container.querySelectorAll('.order-row');
    expect(slots).toHaveLength(20);
    expect(container.querySelector('.order-divider')).toBe(slots[10]);
    expect(slots[10]).toHaveTextContent('체결강도');
    expect(container.querySelectorAll('[data-order-price]')).toHaveLength(askCount + bidCount);
    expect(container.querySelector('.order-empty button')).toBeNull();
  });
  it.each(['KRX', 'NXT', 'UN'] as const)('%s 시세를 조회해도 실계좌 주문 본문에는 거래소를 보내지 않는다', async venue => {
    useLiveVenueStore.setState({ venue });
    show();
    expect(useLiveSeries).toHaveBeenLastCalledWith('005930', venue);
    expect(useQuoteByCode).toHaveBeenLastCalledWith(['005930'], venue);
    expect(useLiveViStatus).toHaveBeenLastCalledWith('005930', venue);
    expect(screen.queryByLabelText('시세·주문 기준')).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0]).toEqual(['/orders', {
      account_seq: 1, command_id: expect.any(String), code: '005930', side: 'BUY', price: 67200,
      quantity: 10, confirm_high_value: false,
    }, 'live']);
  });
  it('통합 선택의 NXT 미상장 종목은 기준 라벨 없이 KRX 시세를 사용한다', () => {
    symbolMaster.nxtEnabled = false;
    useLiveVenueStore.setState({ venue: 'UN' });
    show();
    expect(screen.queryByLabelText('시세·주문 기준')).not.toBeInTheDocument();
    expect(useLiveViStatus).toHaveBeenLastCalledWith('005930', 'KRX');
  });
  it('venue 전환은 고액 확인을 닫고 주문 수량·계좌 주문을 유지한다', () => {
    mock.orders = [order()];
    show();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '2000' } });
    fireEvent.pointerEnter(screen.getByRole('button', { name: /매수 67,300원 주문 추가/ }).closest('.order-row')!);
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,300원 주문 추가/ }));
    expect(screen.getByRole('dialog', { name: '고액 주문 확인' })).toBeInTheDocument();
    act(() => useLiveVenueStore.setState({ venue: 'NXT' }));
    expect(screen.queryByRole('dialog', { name: '고액 주문 확인' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(2000);
    expect(screen.getByLabelText('매수 67,200원 주문', { exact: true })).toBeInTheDocument();
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('134,400,000원');
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('거래소를 바꾸면 10호가창과 주문창의 잔량·체결·체결강도·요약이 함께 바뀐다', () => {
    const originalSeries = vi.mocked(useLiveSeries).getMockImplementation()!;
    const originalQuotes = vi.mocked(useQuoteByCode).getMockImplementation()!;
    const indexOf = (venue: LiveVenueOption) => ['KRX', 'NXT', 'UN'].indexOf(venue) + 1;
    vi.mocked(useLiveSeries).mockImplementation((_code, venue) => {
      const index = indexOf(venue), price = 67200 + index * 1000;
      return { initial: undefined, isLoading: false, error: null, broker: [], program: [], expected: [], afterHours: [], ob: [],
        latestOb: { t_ms: mock.now, asks: Array.from({ length: 10 }, (_, i) => ({ price: price + 100 + i * 100, qty: index * 1000 + i })),
          bids: Array.from({ length: 10 }, (_, i) => ({ price: price - i * 100, qty: index * 2000 + i })), total_ask_qty: index * 10000, total_bid_qty: index * 20000 },
        trade: [{ t_ms: mock.now, fill_strength_pct: index * 50, trades: [{ price, qty: index * 7, side: 1 }] }],
      };
    });
    vi.mocked(useQuoteByCode).mockImplementation((_codes, venue = 'KRX') => {
      const index = indexOf(venue);
      return new Map([['005930', { code: '005930', price: 67200 + index * 1000, change_pct: 0, change_won: 0,
        baseline_price: 66000, volume: index * 100000, trade_value: index * 100000000, high: 70000, low: 65000, open: 67000 }]]);
    });
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const win: WorkspaceWindow = { id: 'book', kind: 'book', group: 1, rect: { x: 0, y: 0, w: 560, h: 640 } };
      const view = render(<QueryClientProvider client={client}>
        <div data-testid="compare-book"><DataWindow win={win} symbol={{ code: '005930', name: '삼성전자' }} /></div>
        <div data-testid="compare-order"><OrderWindow code="005930" name="삼성전자" /></div>
      </QueryClientProvider>);
      const book = within(screen.getByTestId('compare-book'));
      const orderWindow = within(screen.getByTestId('compare-order'));
      fireEvent.click(orderWindow.getByRole('button', { name: '종목 상세 정보' }));
      const orderSummary = screen.getByRole('dialog', { name: '종목 상세 정보' });
      for (const venue of ['KRX', 'NXT', 'UN'] as const) {
        act(() => useLiveVenueStore.setState({ venue }));
        const index = indexOf(venue), price = 67200 + index * 1000;
        for (const scope of [book, orderWindow]) {
          expect(scope.getByLabelText(`매도총잔량 ${(index * 10000).toLocaleString('ko-KR')}`)).toBeInTheDocument();
          expect(scope.getByLabelText(`매수총잔량 ${(index * 20000).toLocaleString('ko-KR')}`)).toBeInTheDocument();
        }
        const bestAsk = screen.getByTestId('compare-order').querySelector(`[data-order-price="${price + 100}"] .order-depth-qty`);
        expect(bestAsk).toHaveTextContent((index * 1000).toLocaleString('ko-KR'));
        expect(screen.getByTestId('compare-book')).toHaveTextContent((index * 1000).toLocaleString('ko-KR'));
        expect(screen.getByTestId('compare-book')).toHaveTextContent(`${(index * 50).toFixed(2)}%`);
        expect(screen.getByTestId('compare-order')).toHaveTextContent(`체결강도${index * 50}%`);
        expect(screen.getByTestId('compare-order').querySelectorAll('.order-info')[1]).toHaveTextContent(`${price.toLocaleString('ko-KR')}${index * 7}`);
        expect(screen.getByTestId('compare-book')).toHaveTextContent(price.toLocaleString('ko-KR'));
        expect(book.getByTestId('book-summary').textContent).toBe(within(orderSummary).getByTestId('book-summary').textContent);
      }
      expect(mock.command).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      vi.mocked(useLiveSeries).mockImplementation(originalSeries);
      vi.mocked(useQuoteByCode).mockImplementation(originalQuotes);
    }
  });
  it('매입수량 클릭은 미체결 매도를 제외한 매도 가능 수량을 채우고 다음 주문에 사용한다', async () => {
    mock.holdingQuantity = '63'; mock.sellableQuantity = '43';
    const sell = { ...order(), side: 'SELL' as const, quantity: '30', execution: { ...order().execution, filledQuantity: '10' } };
    mock.orders = [sell];
    show();
    fireEvent.click(screen.getByRole('button', { name: '매입수량' }));
    expect(screen.getByLabelText('매입수량')).toHaveTextContent('63');
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(43);
    expect(mock.command).not.toHaveBeenCalled();
    const sellButton = screen.getByRole('button', { name: /매도 67,200원 주문 추가/ });
    await waitFor(() => expect(sellButton).toBeEnabled());
    fireEvent.doubleClick(sellButton);
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0]).toEqual(['/orders', expect.objectContaining({ side: 'SELL', quantity: 43 }), 'live']);
  });
  it('금액 버튼을 보고 있어도 보유 클릭은 버튼 종류를 유지하고 같은 수량 칸을 채운다', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '금액' }));
    fireEvent.click(screen.getByRole('button', { name: '매입수량' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(80);
    expect(screen.getByRole('button', { name: '금액' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '100만' })).toBeInTheDocument();
    expect(screen.queryByLabelText('신규 주문 금액')).not.toBeInTheDocument();
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('5,376,000원');
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('매수 주문 수량은 차감하지 않고 서버가 갱신한 매도 가능 수량을 클릭할 때 반영한다', () => {
    mock.holdingQuantity = '63'; mock.sellableQuantity = '63'; mock.orders = [order()];
    const view = show();
    fireEvent.click(screen.getByLabelText('매입수량'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(63);
    mock.sellableQuantity = '43';
    view.rerender(<QueryClientProvider client={new QueryClient()}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>);
    fireEvent.click(screen.getByLabelText('매입수량'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(43);
    expect(mock.command).not.toHaveBeenCalled();
  });
  it.each(['0', '-1', 'NaN', '1.5', '101', undefined])('매도 가능 수량 %s가 없거나 유효하지 않으면 기존 입력값을 유지한다', sellable => {
    mock.sellableQuantity = sellable;
    show();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '37' } });
    expect(screen.getByLabelText('매입수량')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('매입수량'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(37);
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('잔고 조회 실패 시 남아 있는 매도 가능 수량을 입력하지 않는다', () => {
    mock.balancesError = true;
    show();
    expect(screen.getByLabelText('매입수량')).toBeDisabled();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('매수금액은 원본 소수 평단가로 계산하고 정수 경계·누락·보유 없음도 처리한다', () => {
    expect(holdingPurchaseAmountWon(100, '44669.963')).toBe(4466997);
    expect(holdingPurchaseAmountWon(100, '66000.01')).toBe(6600001);
    expect(holdingPurchaseAmountWon(0, null)).toBe(0);
    expect(holdingPurchaseAmountWon(100, null)).toBeNull();
    expect(holdingPurchaseAmountWon(-1, '66000')).toBeNull();
    expect(holdingPurchaseAmountWon(1, '9007199254740992')).toBeNull();
  });
  it('매입수량·평단가는 500ms 호버 후 같은 매수금액을 표시하고 이탈·스크롤·Escape로 닫는다', () => {
    vi.useFakeTimers();
    try {
      mock.averagePrice = '44669.963';
      const view = show();
      const quantity = screen.getByLabelText('매입수량');
      const average = screen.getByLabelText('매입평단가');
      fireEvent.mouseEnter(quantity);
      act(() => vi.advanceTimersByTime(499));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      fireEvent.mouseLeave(quantity);
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      fireEvent.mouseEnter(quantity);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole('tooltip')).toHaveTextContent('매수금액 4,466,997원');
      expect(quantity).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
      fireEvent.mouseLeave(quantity);
      fireEvent.mouseEnter(average);
      fireEvent.scroll(window);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      // jsdom does not track keyboard input modality for :focus-visible.
      vi.spyOn(average, 'matches').mockImplementation(selector => selector === ':focus-visible'
        || Element.prototype.matches.call(average, selector));
      fireEvent.focus(average);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole('tooltip')).toHaveTextContent('매수금액 4,466,997원');
      fireEvent.keyDown(average, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      fireEvent.mouseEnter(quantity);
      view.unmount();
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      expect(mock.command).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each(['매입수량', '매입평단가', '평가손익 표시 전환'])('%s에 마우스·포커스 표시 없이 포커스만 복원돼도 툴팁을 열지 않는다', label => {
    vi.useFakeTimers();
    try {
      mock.holdingQuantity = '547'; mock.averagePrice = '123830';
      show();
      const target = screen.getByLabelText(label);
      vi.spyOn(target, 'matches').mockImplementation(selector => selector !== ':focus-visible'
        && Element.prototype.matches.call(target, selector));
      fireEvent.focus(target);
      act(() => vi.advanceTimersByTime(600));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      expect(mock.command).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('실계좌의 매수·매도는 단일 클릭으로 보내지 않고 더블클릭당 한 건만 보낸다', async () => {
    show();
    for (const [label, side] of [['매수', 'BUY'], ['매도', 'SELL']] as const) {
      const add = screen.getByRole('button', { name: new RegExp(`${label} 67,200원 주문 추가`) });
      await waitFor(() => expect(add).toBeEnabled());
      mock.command.mockClear();
      // 실제 더블클릭 앞의 두 click 이벤트도 신규 주문을 보내면 안 된다.
      fireEvent.click(add, { detail: 1 });
      fireEvent.click(add, { detail: 2 });
      expect(mock.command).not.toHaveBeenCalled();
      fireEvent.doubleClick(add);
      await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
      expect(mock.command.mock.calls[0]).toEqual(['/orders', expect.objectContaining({ side, price: 67200, quantity: 10 }), 'live']);
    }
  });
  it('평가수익은 소수 평단가로 계산해 올림하고 정수 경계에서 1원 오차를 만들지 않는다', () => {
    expect(holdingProfitWon(100, 67200, '44669.963')).toBe(2253004);
    expect(holdingProfitWon(100, 67200, '66000.01')).toBe(119999);
    expect(holdingProfitWon(100, 67200, '67500.125')).toBe(-30012);
    expect(holdingProfitWon(0, null, null)).toBe(0);
    expect(holdingProfitWon(100, null, '66000')).toBeNull();
    expect(holdingProfitWon(100, 67200, null)).toBeNull();
  });
  it('수익률은 원본 소수 평단가로 계산하고 0.01% 경계에서 반올림한다', () => {
    expect(holdingProfitPercent(100, 67200, '70304.99999')).toBe(-4.42);
    expect(holdingProfitPercent(100, 67200, '66000')).toBe(1.82);
    expect(holdingProfitPercent(1, 20001, '20000')).toBe(0.01);
    expect(holdingProfitPercent(100, 19999, '20000')).toBe(-0.01);
    expect(holdingProfitPercent(100, 66000, '66000')).toBe(0);
    expect(holdingProfitPercent(0, 67200, '66000')).toBeNull();
    expect(holdingProfitPercent(100, null, '66000')).toBeNull();
    expect(holdingProfitPercent(100, 67200, null)).toBeNull();
    expect(holdingProfitPercent(100, 67200, '0')).toBeNull();
  });
  it('평가손익 숫자는 더블클릭으로 금액과 %를 전환하며 주문하지 않는다', () => {
    vi.useFakeTimers();
    try {
      mock.averagePrice = '70304.99999';
      show();
      const toggle = screen.getByRole('button', { name: '평가손익 표시 전환' });
      expect(toggle).toHaveTextContent('-310,499');
      expect(toggle).not.toHaveAttribute('title');
      fireEvent.mouseEnter(toggle);
      act(() => vi.advanceTimersByTime(499));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole('tooltip')).toHaveTextContent('-4.42%');
      expect(screen.getByRole('tooltip')).toHaveClass('order-tooltip');
      expect(toggle).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
      fireEvent.click(toggle);
      expect(toggle).toHaveTextContent('-310,499');
      fireEvent.doubleClick(toggle);
      expect(toggle).toHaveTextContent('-4.42%');
      expect(screen.getByRole('tooltip')).toHaveTextContent('-310,499원');
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      expect(toggle.querySelector('.order-field-value')).toHaveClass('text-price-down');
      fireEvent.doubleClick(toggle);
      expect(toggle).toHaveTextContent('-310,499');
      expect(screen.getByRole('tooltip')).toHaveTextContent('-4.42%');
      fireEvent.mouseLeave(toggle);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      expect(mock.command).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('수익률 표시는 시세 갱신을 따르고 종목 변경 후에도 유지한다', () => {
    vi.useFakeTimers();
    try {
      const view = show();
      const toggle = () => screen.getByRole('button', { name: '평가손익 표시 전환' });
      // Use the same keyboard-accessible tooltip UI as the holding quantity and average.
      const profitButton = toggle();
      vi.spyOn(profitButton, 'matches').mockImplementation(selector => selector === ':focus-visible'
        || Element.prototype.matches.call(profitButton, selector));
      fireEvent.focus(toggle());
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole('tooltip')).toHaveTextContent('1.82%');
      fireEvent.keyDown(toggle(), { key: 'Enter' });
      expect(toggle()).toHaveTextContent('1.82%');
      expect(screen.getByRole('tooltip')).toHaveTextContent('120,000원');
      mock.quotePrice = 65700;
      view.rerender(<QueryClientProvider client={new QueryClient()}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>);
      expect(toggle()).toHaveTextContent('-0.45%');
      expect(screen.getByRole('tooltip')).toHaveTextContent('-30,000원');
      fireEvent.keyDown(toggle(), { key: ' ' });
      expect(toggle()).toHaveTextContent('-30,000');
      expect(screen.getByRole('tooltip')).toHaveTextContent('-0.45%');
      fireEvent.keyDown(toggle(), { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      fireEvent.keyDown(toggle(), { key: 'Enter' });
      view.rerender(<QueryClientProvider client={new QueryClient()}><OrderWindow code="000660" name="SK하이닉스" /></QueryClientProvider>);
      expect(toggle()).toHaveAttribute('aria-pressed', 'true');
      expect(mock.command).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each([
    [67200, 'text-price-up', '120,000'],
    [65700, 'text-price-down', '-30,000'],
    [66000, 'text-fg', '0'],
    [null, 'text-fg', '—'],
  ] as const)('평가수익은 현재가 %s에서 수익·손실·중립 색을 적용한다', (price, color, value) => {
    mock.quotePrice = price;
    show();
    const field = screen.getByLabelText('보유 종목 평가 수익');
    expect(field.querySelector('.order-field-value')).toHaveClass(color);
    expect(field.querySelector('.order-field-value')?.textContent).toBe(value);
    expect(field.querySelector('.order-meta')).not.toBeInTheDocument();
    if (price === null) expect(within(field).getByRole('button')).not.toHaveAttribute('title');
  });
  it('주·금액은 버튼만 바꾸고 금액 버튼으로 환산한 수량을 한 칸에서 유지한다', async () => {
    show();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '37' } });
    const mode = within(screen.getByRole('group', { name: '빠른 입력 방식' }));
    fireEvent.click(mode.getByRole('button', { name: '금액' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(37);
    expect(screen.queryByLabelText('신규 주문 금액')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '500만' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(74);
    fireEvent.click(mode.getByRole('button', { name: '주' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(74);
    fireEvent.click(mode.getByRole('button', { name: '금액' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(74);
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('4,972,800원');
    expect(mock.command).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ price: 67200, quantity: 74 });
  });
  it('미보유는 보유 0과 평단가·평가손익 없음으로 표시하며 보유 수량을 적용하지 않는다', () => {
    mock.holdingQuantity = '0'; show();
    expect(screen.getByLabelText('매입수량')).toHaveTextContent('0');
    expect(screen.getByLabelText('매입수량')).toBeDisabled();
    expect(screen.getByLabelText('매입평단가')).toHaveTextContent('—');
    expect(screen.getByLabelText('보유 종목 평가 수익')).toHaveTextContent('—');
    expect(screen.getByRole('button', { name: '평가손익 표시 전환' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '평가손익 표시 전환' })).not.toHaveAttribute('title');
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('평단가 표시는 즉시 저장되고 닫기·Escape로 되돌아가지 않는다', () => {
    mock.averagePrice = '67000.1';
    const { container } = show();
    const settings = screen.getByRole('button', { name: '주문 설정' });
    const marker = () => container.querySelector('.order-average-marker');
    fireEvent.click(settings);
    expect(screen.queryByRole('button', { name: '적용' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: '내 평단가 표시' }));
    expect(marker()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정 닫기' }));
    fireEvent.click(settings);

    expect(screen.getByRole('switch', { name: '내 평단가 표시' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('switch', { name: '내 평단가 표시' }));
    expect(marker()).not.toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog', { name: '주문 설정' }), { key: 'Escape' });
    fireEvent.click(settings);

    expect(screen.getByRole('switch', { name: '내 평단가 표시' })).toBeChecked();
    fireEvent.click(settings);
    expect(screen.getByLabelText('매입평단가')).toHaveTextContent('67,001');
    expect(mock.command).not.toHaveBeenCalled();
  });

  it('평단가 표시 설정과 관계없이 범위 밖 안내 없이 상단 숫자를 유지한다', () => {
    show();
    expect(screen.queryByText('호가 범위 밖')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));

    fireEvent.click(screen.getByRole('switch', { name: '내 평단가 표시' }));
    fireEvent.click(screen.getByRole('button', { name: '주문 설정 닫기' }));
    expect(screen.queryByText('호가 범위 밖')).not.toBeInTheDocument();
    expect(screen.getByLabelText('매입평단가')).toHaveTextContent('66,000');
  });
  it('차트와 같은 단일 본문에 모든 설정과 즉시 저장 안내를 표시한다', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    const dialog = screen.getByRole('dialog', { name: '주문 설정' });
    expect(within(dialog).queryByRole('navigation')).not.toBeInTheDocument();
    expect(within(dialog).getByText('이 창에 적용')).toBeVisible();
    expect(within(dialog).getByRole('status')).toHaveTextContent('변경 즉시 반영');
    const quantity = within(dialog).getByRole('spinbutton', { name: '수량 프리셋 1' });
    fireEvent.change(quantity, { target: { value: '25' } });
    for (const section of ['주문 입력', '호가 표시', '주문 알림']) {
      expect(within(dialog).getByRole('region', { name: section })).toBeVisible();
      expect(within(dialog).getByRole('heading', { name: section })).toBeVisible();
    }
    expect(quantity).toHaveValue(25);
    expect(within(dialog).getByRole('switch', { name: '내 평단가 표시' })).toBeVisible();
    expect(within(dialog).getByRole('switch', { name: '주문접수 소리' })).toBeVisible();
    expect(mock.command).not.toHaveBeenCalled();
  });

  it('프리셋은 즉시 저장하고 빈칸·범위 밖 값은 이전 값을 유지하며 다른 항목은 저장한다', async () => {
    const view = show();
    const edit = () => fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    edit();
    const dialog = screen.getByRole('dialog', { name: '주문 설정' });
    expect(within(dialog).getAllByRole('spinbutton')).toHaveLength(6);
    expect(within(dialog).queryByText('변경 사항이 자동 저장됩니다.')).not.toBeInTheDocument();
    const amount = screen.getByLabelText('금액 프리셋 1');
    fireEvent.change(amount, { target: { value: '' } });
    expect(amount).toHaveValue(null);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('양의 정수만 저장');
    for (const value of ['0', '-1', '1.5', '1000001']) {
      fireEvent.change(amount, { target: { value } });
      expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    }
    for (const [i, value] of [25, 75, 250].entries()) fireEvent.change(screen.getByLabelText(`수량 프리셋 ${i + 1}`), { target: { value: String(value) } });

    fireEvent.click(screen.getByRole('switch', { name: '내 평단가 표시' }));
    expect(view.container.querySelector('.order-average-marker')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정 닫기' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(25);
    edit();
    expect(screen.getByLabelText('금액 프리셋 1')).toHaveValue(1);
    expect(screen.getByLabelText('수량 프리셋 2')).toHaveValue(75);

    expect(screen.getByRole('switch', { name: '내 평단가 표시' })).not.toBeChecked();

    fireEvent.change(screen.getByLabelText('금액 프리셋 1'), { target: { value: '2' } });
    fireEvent.keyDown(screen.getByRole('dialog', { name: '주문 설정' }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '75주' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(75);
    expect(screen.getByRole('button', { name: '250주' })).toBeInTheDocument();
    expect(mock.command).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ quantity: 75 });
  });

  it('금액 버튼은 현재가로 한 번 환산하고 서로 다른 매수·매도 호가에도 같은 수량을 전송한다', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '금액' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(10);
    fireEvent.click(screen.getByRole('button', { name: '500만' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(74);
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 68,000원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ side: 'BUY', price: 68000, quantity: 74 });
    const sell = screen.getByRole('button', { name: /매도 66,300원 주문 추가/ });
    await waitFor(() => expect(sell).toBeEnabled()); fireEvent.doubleClick(sell);
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1][1]).toMatchObject({ side: 'SELL', price: 66300, quantity: 74 });
    fireEvent.click(screen.getByRole('button', { name: '주' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(74);
  });
  it('환산 결과가 1주 미만이면 수량 0과 이유를 표시하고 신규 주문을 제한한다', () => {
    mock.priceOffset = 1400000; mock.quotePrice = 1467200; show();
    fireEvent.click(screen.getByRole('button', { name: '금액' }));
    fireEvent.click(screen.getByRole('button', { name: '100만' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(0);
    expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent('1주를 주문할 수 없습니다');
    expect(screen.getByRole('button', { name: /매수 1,467,200원 주문 추가/ })).toHaveAttribute('aria-disabled', 'true');
    expect(mock.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '매입수량' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(80);
    expect(screen.getByRole('button', { name: '금액' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('alert', { name: '주문 알림' })).not.toBeInTheDocument();
  });
  it('100만원은 현재가 67,300원에서 14주로 환산하고 현재가·호버 변동에는 수량을 고정한다', () => {
    mock.quotePrice = 67300;
    const view = show();
    fireEvent.click(screen.getByRole('button', { name: '금액' }));
    fireEvent.pointerEnter(screen.getByRole('button', { name: /매수 68,200원 주문 추가/ }).closest('[data-order-price]')!);
    fireEvent.click(screen.getByRole('button', { name: '100만' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(14);
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('942,200원');
    mock.quotePrice = 75000;
    view.rerender(<QueryClientProvider client={new QueryClient()}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>);
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(14);
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('1,050,000원');
    fireEvent.click(screen.getByRole('button', { name: '100만' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(13);
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('975,000원');
    expect(mock.command).not.toHaveBeenCalled();
  });
  it.each([null, 0, -1, NaN, Infinity])('현재가 %s는 금액 환산을 막고 입력 수량을 유지한다', price => {
    mock.quotePrice = price;
    show();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '37' } });
    fireEvent.click(screen.getByRole('button', { name: '금액' }));
    expect(screen.getByRole('button', { name: '100만' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '100만' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(37);
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('금액 프리셋은 현재가로 한 번만 환산하고 버튼 전환은 빈 수량을 채우지 않는다', () => {
    show();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '금액' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(null);
    fireEvent.click(screen.getByRole('button', { name: '100만' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(14);
    fireEvent.click(screen.getByRole('button', { name: '주' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(14);
    fireEvent.click(screen.getByRole('button', { name: '50주' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(50);
  });
  it('공통 수량을 양방향 주문에 사용하고 호버·포커스와 관계없이 현재가로 예상 금액을 표시한다', async () => {
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
    fireEvent.focus(buy);
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('3,360,000원');
    expect(screen.getByLabelText('예상 주문 금액')).toHaveAttribute('title', '67,200원 기준');
    fireEvent.doubleClick(buy);
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ side: 'BUY', quantity: 50, price: 67300 });
    const sell = screen.getByRole('button', { name: /매도 67,200원 주문 추가/ });
    await waitFor(() => expect(sell).toBeEnabled());
    fireEvent.doubleClick(sell);
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1][1]).toMatchObject({ side: 'SELL', quantity: 50, price: 67200 });
    fireEvent.pointerLeave(view.container.querySelector('.order-ladder')!);
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('3,360,000원');
  });
  it('보유 정보와 매수 가능 금액은 상단에만 표시하고 시세 상세는 10호가 형식을 쓴다', () => {
    mock.buyingPower = '9759'; mock.averagePrice = '44669.963'; show();
    expect(screen.getByLabelText('매수 가능 금액')).toHaveTextContent('매수 가능9,759원');
    expect(screen.queryByLabelText('매도 가능 수량')).not.toBeInTheDocument();
    expect(screen.getByLabelText('매입수량').querySelector('.order-field-value')?.textContent).toBe('100');
    expect(screen.getByLabelText('매입평단가').querySelector('.order-field-value')?.textContent).toBe('44,670');
    expect(screen.getByLabelText('보유 종목 평가 수익').querySelector('.order-field-value')?.textContent).toBe('2,253,004');
    expect(within(screen.getByRole('group', { name: '보유 종목 정보' })).getByLabelText('매입수량')).toBeInTheDocument();
    expect(screen.getByLabelText('매수 가능 금액').closest('.order-overview-controls')).toBeInTheDocument();
    expect(screen.getByLabelText('매수 가능 금액').previousElementSibling).toBe(screen.getByRole('group', { name: '보유 종목 정보' }));
    expect(within(screen.getByRole('group', { name: '보유 종목 정보' })).queryByLabelText('매수 가능 금액')).not.toBeInTheDocument();
    for (const label of ['보유', '평단가', '평가손익']) expect(screen.queryByText(label, { exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '종목 상세 정보' }));
    const summary = within(screen.getByRole('dialog', { name: '종목 상세 정보' })).getByTestId('book-summary');
    const summaryContent = within(summary);
    expect(summaryContent.queryByText('매수 가능')).not.toBeInTheDocument();
    expect(summaryContent.queryByText('매도 가능')).not.toBeInTheDocument();
    expect(summaryContent.getByText('KRX종가')).toBeInTheDocument();
    expect(summaryContent.getByText('833만')).toBeInTheDocument();
    expect(summaryContent.getByText('184.55%')).toBeInTheDocument();
    expect(summaryContent.getByText('12조 2,908억')).toBeInTheDocument();
    fireEvent.click(summaryContent.getByText('833만'));
    for (const label of ['상한가', '하한가', '상승VI', '하강VI']) expect(summaryContent.getByText(label)).toBeInTheDocument();
    expect(summaryContent.queryByText('250일')).not.toBeInTheDocument();
    expect(summaryContent.queryByText('70,000/50,000')).not.toBeInTheDocument();
  });
  it('가격이나 유효 수량이 없으면 예상 금액을 계산하지 않고 잘못된 수량은 전송하지 않는다', () => {
    mock.quotePrice = null; show();
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('—');
    expect(screen.getByLabelText('보유 종목 평가 수익')).toHaveTextContent('—');
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '1.5' } });
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    expect(mock.command).not.toHaveBeenCalled();
    expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent('정수');
  });
  it('보유 평가 수익은 원본 평단가·전체 보유 수량·현재가로 계산하고 선택 호가·주문 수량에는 영향받지 않는다', () => {
    mock.buyingPower = '9759'; show();
    const valuation = screen.getByLabelText('보유 종목 평가 수익');
    expect(screen.getByLabelText('매입수량')).toHaveTextContent('100');
    expect(screen.getByLabelText('매입평단가')).toHaveTextContent('66,000');
    expect(valuation).toHaveTextContent('120,000'); // 전체 보유 100주, 매도 가능 80주
    expect(screen.getByLabelText('매입평단가').nextElementSibling).toBe(valuation);
    fireEvent.pointerEnter(screen.getByRole('button', { name: /매수 67,300원 주문 추가/ }).closest('.order-row')!);
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '50' } });
    expect(valuation).toHaveTextContent('120,000');
    mock.quotePrice = 67400;
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '20' } });
    expect(valuation).toHaveTextContent('140,000');
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('왼쪽 매도·오른쪽 매수 영역 더블클릭은 확인창 없이 즉시 주문한다', async () => {
    const view = show(); const add = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    expect(add).toHaveTextContent(''); expect(view.container.textContent).not.toContain('⠿');
    const row = add.closest('.order-row')!;
    expect(Array.from(row.querySelectorAll('[data-order-side]')).map(lane => (lane as HTMLElement).dataset.orderSide)).toEqual(['SELL', 'BUY']);
    expect(view.container.querySelector('.order-topline,.order-quote,.order-footer,.order-position,.order-cancel-zone,.order-status,.order-history')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '즉시 주문' })).not.toBeInTheDocument();
    fireEvent.doubleClick(add);
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '주문 접수' })).not.toBeInTheDocument();
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][2]).toBe('live');
    expect(mock.command.mock.calls[0][1]).toMatchObject({ account_seq: 1, code: '005930', side: 'BUY', price: 67200, quantity: 10, confirm_high_value: false });
  });
  it('부분 체결을 제외한 잔량만 표시하고 클릭해도 하단 편집 UI가 열리지 않는다', () => {
    mock.orders = [order(), { ...order('outside'), price: '70000' }];
    const view = show(); const chip = screen.getByLabelText('매수 67,200원 주문', { exact: true });
    expect(view.container.querySelector('.order-outside')).toBeNull();
    expect(screen.queryByRole('button', { name: '호가 밖 매수 70,000원 주문' })).not.toBeInTheDocument();
    expect(chip).toHaveTextContent(/^70$/); fireEvent.click(chip);
    expect(screen.queryByLabelText('정정 수량')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('주문 가격')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '이 주문 취소' })).not.toBeInTheDocument();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('매수 미체결과 같은 가격에서도 신규 매수·매도 영역을 활성화한다', () => {
    mock.orders = [order()]; show(); expect(screen.getByRole('button', { name: /매도 67,200원 주문 추가/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeEnabled();
  });
  it.each(['BUY', 'SELL'] as const)('%s 주문 수량과 칸 전체의 더블클릭은 같은 가격에 현재 수량으로 추가 주문한다', async side => {
    mock.orders = [{ ...order(), side }];
    const view = show();
    const label = side === 'BUY' ? '매수' : '매도';
    const cell = screen.getByRole('button', { name: new RegExp(`${label} 67,200원 주문 추가`) });
    const quantity = screen.getByLabelText(`${label} 67,200원 주문`, { exact: true });
    expect(quantity.closest('button')).toBe(cell);
    expect(cell.querySelector('button')).toBeNull();
    expect(view.container.querySelector('.order-add')).toBeNull();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '25' } });
    for (const target of [quantity, cell]) {
      await waitFor(() => expect(cell).toBeEnabled());
      mock.command.mockClear();
      fireEvent.click(target, { detail: 1 });
      fireEvent.click(target, { detail: 2 });
      expect(mock.command).not.toHaveBeenCalled();
      fireEvent.doubleClick(target);
      await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
      expect(mock.command.mock.calls[0][1]).toMatchObject({ side, price: 67200, quantity: 25 });
    }
  });
  it('오래된 호가·무자격 신규 주문은 막되 연결된 주문의 드래그 취소는 허용한다', () => {
    mock.snapshotAt = mock.now - 60_000; mock.orders = [order()]; const view = show();
    const cell = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    expect(cell).toBeEnabled();
    fireEvent.doubleClick(cell);
    expect(mock.command).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /매수 67,100원 주문 추가/ })).toHaveAttribute('aria-disabled', 'true');
    const chip = screen.getByLabelText('매수 67,200원 주문', { exact: true });
    expect(chip.closest('button')).toBeEnabled(); expect(chip).toHaveAttribute('data-drag-order', 'a');
    fireEvent.click(chip);
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    view.unmount(); mock.configured = false; show(); expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toHaveAttribute('aria-disabled', 'true');
  });
  it('실계좌 고액 주문은 금액 확인 전에는 전송하지 않는다', async () => {
    show(); fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '2000' } });
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    expect(mock.command).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: '고액 주문 확인' })).toBeInTheDocument();
    expect(screen.queryByLabelText('주문 가격')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '확인 후 주문' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '1억원 이상 주문 금액을 확인했습니다' }));
    fireEvent.click(screen.getByRole('button', { name: '확인 후 주문' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0]).toEqual(['/orders', expect.objectContaining({ quantity: 2000, confirm_high_value: true }), 'live']);
  });
  it('같은 가격의 여러 주문은 한 칸에 합산하고 우클릭 목록에서 개별 잔량을 표시한다', () => {
    mock.orders = [order('a'), order('b'), { ...order('other'), price: '67100' }]; show();
    const cell = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    expect(cell).toHaveTextContent(/^140$/);
    fireEvent.contextMenu(cell, { clientX: 100, clientY: 100 });
    const menu = screen.getByRole('menu', { name: '매수 67,200원 주문 목록' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    expect(within(menu).getByRole('menuitem', { name: '주문 1 · 70주' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: '주문 2 · 70주' })).toBeEnabled();
    expect(menu).toHaveTextContent('매수삼성전자');
    expect(menu.querySelector('.order-list-summary')).toBeNull();
    expect(menu).not.toHaveTextContent('other');
    expect(mock.command).not.toHaveBeenCalled();
    const a = order(), b = { ...order('b'), side: 'SELL' as const }; expect(groupPriceOrders([a, b]).size).toBe(2); expect(orderRemainder(a)).toBe(70);
  });
  it('우클릭 목록의 처리 중 주문은 개별 드래그를 막고 Escape로 목록을 닫는다', () => {
    mock.orders = [order('a'), { ...order('b'), status: 'PENDING_CANCEL' }]; show();
    const cell = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    fireEvent.contextMenu(cell, { clientX: 100, clientY: 100 });
    const item = screen.getByRole('menuitem', { name: '주문 2 · 70주' });
    expect(item).toBeDisabled();
    expect(item.textContent).toBe('67,20070');
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('키보드 단축키는 주문을 전송하거나 수량·금액 프리셋을 선택하지 않는다', () => {
    mock.orders = [order()]; show();
    const chip = screen.getByLabelText('매수 67,200원 주문', { exact: true });
    fireEvent.click(chip);
    for (const key of ['ArrowUp', 'ArrowDown', 'Delete']) fireEvent.keyDown(chip, { key, ctrlKey: true });
    fireEvent.keyDown(chip, { key: 'Backspace', ctrlKey: true, shiftKey: true });
    expect(mock.command).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '37' } });
    for (const mode of ['주', '금액']) {
      fireEvent.click(screen.getByRole('button', { name: mode }));
      for (const key of ['1', '2', '3']) {
        fireEvent.keyDown(chip, { key, ctrlKey: true });
        expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(37);
      }
    }
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('모의투자 UI 없이 항상 실계좌로 즉시 주문한다', async () => {
    show();
    expect(screen.queryByRole('combobox', { name: '주문 모드' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '모의 계좌 설정' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '모의 계좌 초기화' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('시세·주문 기준')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '즉시 주문' })).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][2]).toBe('live');
  });

  it('종목을 바꾸면 수량을 비우고 새 수량을 입력해야 주문할 수 있다', async () => {
    mock.accountCount = 2; mock.orders = [order()];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const win: WorkspaceWindow = { id: 'order-context', kind: 'order', group: 1, rect: { x: 0, y: 0, w: 720, h: 720 } };
    const view = render(<QueryClientProvider client={client}><DataWindow win={win} symbol={{ code: '005930', name: '삼성전자' }} /></QueryClientProvider>);
    await screen.findByRole('combobox', { name: '주문 계좌' });
    fireEvent.change(screen.getByRole('combobox', { name: '주문 계좌' }), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '123' } });
    fireEvent.click(screen.getByLabelText('매수 67,200원 주문', { exact: true }));
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    mock.orders = [];
    view.rerender(<QueryClientProvider client={client}><DataWindow win={win} symbol={{ code: '000660', name: 'SK하이닉스' }} /></QueryClientProvider>);
    expect(screen.getByRole('combobox', { name: '주문 계좌' })).toHaveValue('2');
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(null);
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('—');
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    const buy = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    expect(buy).toHaveAttribute('aria-disabled', 'true');
    fireEvent.doubleClick(buy);
    expect(mock.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '7' } });
    expect(buy).toBeEnabled();
    fireEvent.doubleClick(buy);
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0]).toEqual(['/orders', expect.objectContaining({ account_seq: 2, code: '000660', quantity: 7 }), 'live']);
  });

  it('수량 기억은 즉시 저장되며 끄면 현재 입력만 유지하고 기록은 비운다', () => {
    const client = new QueryClient();
    const content = (code: string) => <QueryClientProvider client={client}><OrderWindow code={code} name={code} /></QueryClientProvider>;
    const view = render(content('005930'));
    const edit = () => fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    const toggle = () => fireEvent.click(screen.getByRole('switch', { name: '종목별 주문수량 기억' }));
    edit();
    expect(screen.getByRole('switch', { name: '종목별 주문수량 기억' })).not.toBeChecked();
    toggle();
    fireEvent.keyDown(screen.getByRole('dialog', { name: '주문 설정' }), { key: 'Escape' });
    edit(); expect(screen.getByRole('switch', { name: '종목별 주문수량 기억' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정 닫기' }));
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '30' } });
    view.rerender(content('000660'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(null);
    view.rerender(content('005930'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(30);
    edit(); toggle();
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(30);
    fireEvent.click(screen.getByRole('button', { name: '주문 설정 닫기' }));
    view.rerender(content('000660')); view.rerender(content('005930'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(null);
    edit(); toggle(); fireEvent.click(screen.getByRole('button', { name: '주문 설정 닫기' }));
    view.rerender(content('000660')); view.rerender(content('005930'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(null);
    expect(mock.command).not.toHaveBeenCalled();
  });

  it('수량 기억은 기본 계좌를 포함해 계좌·종목별로 복원하며 직접 지운 빈칸도 기억한다', () => {
    mock.accountCount = 2;
    const client = new QueryClient();
    const settings = normalizeOrderSettings({ rememberQuantity: true });
    const content = (code: string) => <QueryClientProvider client={client}><OrderWindow code={code} name={code} settings={settings} /></QueryClientProvider>;
    const view = render(content('005930'));
    const input = () => screen.getByLabelText('신규 주문 수량');
    const select = (account: string) => fireEvent.change(screen.getByRole('combobox', { name: '주문 계좌' }), { target: { value: account } });
    fireEvent.change(input(), { target: { value: '30' } });
    select('2'); expect(input()).toHaveValue(null);
    fireEvent.change(input(), { target: { value: '9' } });
    view.rerender(content('000660')); expect(input()).toHaveValue(null);
    fireEvent.change(input(), { target: { value: '5' } });
    view.rerender(content('005930')); expect(input()).toHaveValue(9);
    select('1'); expect(input()).toHaveValue(30);
    view.rerender(content('000660')); expect(input()).toHaveValue(null);
    select('2'); expect(input()).toHaveValue(5);
    fireEvent.change(input(), { target: { value: '' } });
    view.rerender(content('005930')); expect(input()).toHaveValue(9);
    view.rerender(content('000660')); expect(input()).toHaveValue(null);
    expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toHaveAttribute('aria-disabled', 'true');
    expect(mock.command).not.toHaveBeenCalled();
  });

  it('금액 프리셋의 환산 주수를 기억하고 시세 변경으로 재환산하거나 새 창에 복원하지 않는다', () => {
    const client = new QueryClient();
    const settings = normalizeOrderSettings({ rememberQuantity: true, unit: 'amount' });
    const content = (code: string, id = 'first') => <QueryClientProvider client={client}><OrderWindow key={id} code={code} name={code} settings={settings} /></QueryClientProvider>;
    const view = render(content('005930'));
    fireEvent.click(screen.getByRole('button', { name: '500만' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(74);
    view.rerender(content('000660'));
    mock.quotePrice = 100000;
    view.rerender(content('005930'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(74);
    view.rerender(content('005930', 'new-window'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(10);
    expect(mock.command).not.toHaveBeenCalled();
  });

  it('종목을 다시 방문해도 수량은 빈칸이고 직접 지워도 0이나 프리셋으로 바뀌지 않는다', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const settings = { unit: 'quantity' as const, quantityPresets: [25, 75, 125] as [number, number, number],
      amountPresets: [2, 6, 12] as [number, number, number], showAveragePrice: true, orderReceiptSound: false, rememberQuantity: false };
    const content = (code: string) => <QueryClientProvider client={client}><OrderWindow code={code} name={code} settings={settings} /></QueryClientProvider>;
    const view = render(content('005930'));
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '321' } });
    view.rerender(content('005930'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(321);
    view.rerender(content('000660'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(null);
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '432' } });
    view.rerender(content('005930'));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(null);
    fireEvent.click(screen.getByRole('button', { name: '25주' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(25);
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '' } });
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(null);
    expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toHaveAttribute('aria-disabled', 'true');
    expect(mock.command).not.toHaveBeenCalled();
  });

  it('실패는 신규 확인창 없이 알리고 재확인은 같은 요청 ID를 사용한다', async () => {
    mock.command.mockRejectedValueOnce(new Error('주문 처리 결과 확인 필요'));
    show(); fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent('주문 처리 결과 확인 필요'));
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '주문 접수' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '내역 확인' }));
    fireEvent.click(screen.getByRole('button', { name: '같은 요청 다시 확인' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1]).toEqual(mock.command.mock.calls[0]);
  });
  it('총 접수 버튼은 현재 종목의 호가 밖 주문까지 잔량과 건수를 공백 없이 표시한다', () => {
    mock.orders = [order('one'), { ...order('two'), price: '70000' },
      { ...order('sell'), side: 'SELL' }, { ...order('other-symbol'), symbol: '000660' },
      { ...order('filled'), execution: { ...order().execution, filledQuantity: '100' } }];
    show();
    const buy = screen.getByRole('button', { name: '매수 총 접수 주문' });
    expect(buy).toHaveTextContent(/^140\(2\)$/);
    expect(screen.getByRole('button', { name: '매도 총 접수 주문' })).toHaveTextContent(/^70\(1\)$/);
    fireEvent.click(buy); fireEvent.doubleClick(buy);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(mock.command).not.toHaveBeenCalled();
    fireEvent.contextMenu(buy);
    const menu = screen.getByRole('menu', { name: '매수 전체 접수 주문 목록' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    expect(menu).toHaveTextContent('67,200'); expect(menu).toHaveTextContent('70,000');
    expect(menu.querySelector('.order-list-summary')).toBeNull();
    expect(buy).toHaveAttribute('aria-expanded', 'true');
  });
  it('총 접수 목록은 키보드로 열고 처리 중인 주문의 개별 취소와 드래그를 잠근다', () => {
    mock.orders = [{ ...order(), status: 'PENDING_CANCEL' }]; show();
    const buy = screen.getByRole('button', { name: '매수 총 접수 주문' });
    expect(buy).toHaveTextContent(/^70\(1\)$/);
    expect(buy).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: '매도 총 접수 주문' })).toHaveTextContent(/^0\(0\)$/);
    fireEvent.keyDown(buy, { key: 'Enter' });
    const menu = screen.getByRole('menu', { name: '매수 전체 접수 주문 목록' });
    expect(within(menu).getByRole('menuitem')).toBeDisabled();
    expect(within(menu).getByRole('button', { name: '주문 1 개별 취소' })).toBeDisabled();
    fireEvent.click(within(menu).getByRole('button', { name: '주문 1 개별 취소' }));
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('총 접수 목록의 개별 취소는 선택한 주문만 전송하고 처리 중 재전송을 막는다', async () => {
    mock.orders = [order('one'), { ...order('two'), price: '70000' }];
    show();
    const buy = screen.getByRole('button', { name: '매수 총 접수 주문' });
    fireEvent.contextMenu(buy);
    const menu = screen.getByRole('menu', { name: '매수 전체 접수 주문 목록' });
    fireEvent.click(screen.getByRole('button', { name: '주문 2 개별 취소' }));
    await screen.findByText('취소 요청 접수됨');
    expect(mock.command).toHaveBeenCalledExactlyOnceWith('/orders/two/cancel', expect.objectContaining({ account_seq: 1, code: '005930' }), 'live');
    expect(buy).toHaveTextContent(/^140\(2\)$/); // Keep pending orders until the server confirms removal.
    expect(menu).toBeInTheDocument();
    expect(buy).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '주문 2 개별 취소' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '주문 1 개별 취소' })).toBeEnabled();
  });
  it('가격별 목록의 취소 전송 중과 실패 후에도 목록을 유지한다', async () => {
    mock.orders = [order('one')];
    let reject!: (error: Error) => void;
    mock.command.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    show();
    fireEvent.contextMenu(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    const menu = screen.getByRole('menu', { name: '매수 67,200원 주문 목록' });
    fireEvent.click(within(menu).getByRole('button', { name: '주문 1 개별 취소' }));
    expect(menu).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: '주문 1 개별 취소' })).toBeDisabled();
    await act(async () => reject(new Error('취소 요청 실패')));
    expect(menu).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: '주문 1 개별 취소' })).toBeEnabled();
    expect(mock.command).toHaveBeenCalledOnce();
  });
  it('취소 응답을 기다리다 직접 닫은 주문 목록은 응답 후에도 다시 열지 않는다', async () => {
    mock.orders = [order('one')];
    let resolve!: (response: object) => void;
    mock.command.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    show();
    fireEvent.contextMenu(screen.getByRole('button', { name: '매수 총 접수 주문' }));
    fireEvent.click(screen.getByRole('button', { name: '주문 1 개별 취소' }));
    fireEvent.click(screen.getByRole('button', { name: '주문 목록 닫기' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await act(async () => resolve({ order_id: 'cancel-one', status: 'accepted' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it.each([['매수', 'BUY'], ['매도', 'SELL']] as const)('우클릭 %s 주문 취소는 현재 종목의 해당 방향만 취소한다', async (label, side) => {
    mock.orders = [order('buy'), { ...order('sell'), side: 'SELL' }];
    mock.snapshotAt = mock.now - 60_000; // Cancellation stays available with a stale book.
    mock.command.mockResolvedValueOnce({ results: [{ order_id: side === 'BUY' ? 'buy' : 'sell', accepted: true, operation_id: 'cancel' }] });
    const view = show();
    expect(screen.queryByRole('group', { name: '방향별 주문 취소' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${label} 총 접수 주문` })).toHaveTextContent('70(1)');
    fireEvent.contextMenu(view.container.querySelector('.order-ladder')!);
    fireEvent.click(screen.getByRole('menuitem', { name: `${label} 모두 취소` }));
    await screen.findByText('취소 요청 접수됨');
    expect(mock.command).toHaveBeenCalledExactlyOnceWith('/cancel-all', expect.objectContaining({ account_seq: 1, code: '005930', side }), 'live');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('우클릭 주문 취소는 취소할 주문이 없거나 처리 중인 방향을 비활성화한다', () => {
    mock.orders = [{ ...order(), status: 'CANCEL_PENDING' }];
    const view = show();
    fireEvent.contextMenu(view.container.querySelector('.order-ladder')!);
    expect(screen.getByRole('menuitem', { name: '매수 모두 취소' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '매도 모두 취소' })).toBeDisabled();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('우클릭 주문 취소 전송 중 양쪽을 잠그고 중복 요청을 보내지 않는다', async () => {
    mock.orders = [order(), { ...order('sell'), side: 'SELL' }];
    let resolve!: (response: object) => void;
    mock.command.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const view = show();
    fireEvent.contextMenu(view.container.querySelector('.order-ladder')!);
    fireEvent.click(screen.getByRole('menuitem', { name: '매수 모두 취소' }));
    fireEvent.contextMenu(view.container.querySelector('.order-ladder')!);
    const buy = screen.getByRole('menuitem', { name: '매수 모두 취소' });
    const sell = screen.getByRole('menuitem', { name: '매도 모두 취소' });
    expect(buy).toBeDisabled(); expect(sell).toBeDisabled();
    fireEvent.click(buy); fireEvent.click(sell);
    expect(mock.command).toHaveBeenCalledOnce();
    await act(async () => resolve({ results: [{ order_id: 'a', accepted: true, operation_id: 'cancel-a' }] }));
    fireEvent.contextMenu(view.container.querySelector('.order-ladder')!);
    expect(screen.getByRole('menuitem', { name: '매수 모두 취소' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '매도 모두 취소' })).toBeEnabled();
  });
  it('전체 취소 하단 버튼 없이 우클릭 메뉴에서 전체 취소를 즉시 보낸다', async () => {
    mock.orders = [order()]; mock.command.mockResolvedValueOnce({ results: [] });
    const view = show();
    expect(screen.queryByRole('button', { name: '삼성전자 전체 취소' })).not.toBeInTheDocument();
    fireEvent.contextMenu(view.container.querySelector('.order-ladder')!, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: '전체 주문 취소' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][0]).toBe('/cancel-all');
    expect(mock.command.mock.calls[0][1]).toMatchObject({ side: null });
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it.each([['매수 모두 취소', 'BUY'], ['매도 모두 취소', 'SELL']] as const)('우클릭 %s는 해당 방향만 취소한다', async (label, side) => {
    mock.orders = [{ ...order(), side }]; mock.command.mockResolvedValueOnce({ results: [] });
    const view = show();
    fireEvent.contextMenu(view.container.querySelector('.order-ladder')!, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ side });
  });
  it('10호가창의 총잔량 스트립과 세션 라벨을 공유한다', () => {
    show();
    const strip = screen.getByTestId('book-total-strip');
    expect(strip).toHaveTextContent('1,000정규장 · 11:00:002,000');
    expect(screen.getByLabelText('매도총잔량 1,000')).toHaveTextContent('1,000');
    expect(screen.getByLabelText('매수총잔량 2,000')).toHaveTextContent('2,000');
    expect(screen.getByTestId('book-total-fill')).toHaveStyle({ gridTemplateColumns: '1000fr 2000fr' });
    expect(strip).not.toHaveTextContent('매도 잔량'); expect(strip).not.toHaveTextContent('매수 잔량');
  });

  it.each([true, false])('정규장 사다리 존재=%s여도 두 창은 저장 사다리를 유지하며 시간외 잔량·시각을 갱신한다', async hasBook => {
    const originalSeries = vi.mocked(useLiveSeries).getMockImplementation()!;
    const api = vi.spyOn(await import('../../api/client'), 'apiCall');
    const previousNow = mock.now;
    mock.now = Date.UTC(2026, 9, 14, 6, 47); // 15:47 KST
    let afterHours = [{ t_ms: mock.now, total_ask_qty: 879, total_bid_qty: 538 }];
    vi.mocked(useLiveSeries).mockImplementation(() => ({ ...originalSeries('005930', 'KRX'),
      latestOb: hasBook ? { t_ms: Date.UTC(2026, 9, 14, 6, 30), asks: [{ price: 241500, qty: 0 }],
        bids: [{ price: 241000, qty: 0 }], total_ask_qty: 0, total_bid_qty: 0 } : undefined,
      afterHours,
    }));
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const saved = { ts_ms: Date.UTC(2026, 9, 14, 6, 19, 50), seq: 0,
        ask: Array.from({ length: 10 }, (_, i) => ({ price: 67300 + i * 100, qty: 100 })),
        bid: Array.from({ length: 10 }, (_, i) => ({ price: 67200 - i * 100, qty: 200 })),
        tot_ask: 1000, tot_bid: 2000 };
      api.mockResolvedValue({ snapshot: saved });
      const win: WorkspaceWindow = { id: 'close-book', kind: 'book', group: 1, rect: { x: 0, y: 0, w: 560, h: 640 } };
      const content = () => <QueryClientProvider client={client}>
        <div data-testid="close-book"><DataWindow win={win} symbol={{ code: '005930', name: '삼성전자' }} /></div>
        <div data-testid="close-order"><OrderWindow code="005930" name="삼성전자" /></div>
      </QueryClientProvider>;
      const view = render(content());
      const frozenBuy = await screen.findByRole('button', { name: /매수 67,200원 주문 추가/ });
      expect(screen.getAllByText('시간외종가 · 15:47:00')).toHaveLength(2);
      for (const id of ['close-book', 'close-order']) {
        const strip = within(screen.getByTestId(id)).getByTestId('book-total-strip');
        expect(strip).toHaveTextContent('879시간외종가 · 15:47:00538');
        expect(within(strip).getByTestId('book-total-fill')).toHaveStyle({ gridTemplateColumns: '879fr 538fr' });
      }
      expect(api).toHaveBeenCalledTimes(1);
      expect(new URL(api.mock.calls[0][0], 'http://test').searchParams.get('t')).toBe(String(Date.UTC(2026, 9, 14, 6, 20) - 1));
      expect(frozenBuy).toHaveAttribute('aria-disabled', 'true');
      expect(screen.queryByLabelText('신규 주문 상태')).not.toBeInTheDocument();
      fireEvent.doubleClick(frozenBuy);
      expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent('저장된 호가는 조회만 가능합니다');
      expect(mock.command).not.toHaveBeenCalled();
      afterHours = [{ t_ms: mock.now + 1000, total_ask_qty: 0, total_bid_qty: 1640 }];
      view.rerender(content());
      for (const id of ['close-book', 'close-order']) {
        const strip = within(screen.getByTestId(id)).getByTestId('book-total-strip');
        expect(within(strip).getByLabelText('시간외 매도총잔량 0')).toHaveTextContent('0');
        expect(within(strip).getByLabelText('시간외 매수총잔량 1,640')).toHaveTextContent('1,640');
        expect(strip).toHaveTextContent('시간외종가 · 15:47:01');
        expect(within(strip).getByTestId('book-total-fill')).toHaveStyle({ gridTemplateColumns: '0fr 1640fr' });
      }
      expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBe(frozenBuy);
      expect(frozenBuy).toHaveAttribute('aria-disabled', 'true');
      mock.now = Date.UTC(2026, 9, 14, 6, 59, 50);
      vi.mocked(useLiveSeries).mockImplementation(() => originalSeries('005930', 'KRX'));
      mock.snapshotAt = mock.now;
      view.rerender(content());
      await waitFor(() => expect(screen.getAllByText('실시간 호가 · 15:59:50')).toHaveLength(2));
      expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeEnabled();
    } finally {
      api.mockRestore();
      mock.now = previousNow;
      vi.mocked(useLiveSeries).mockImplementation(originalSeries);
    }
  });

  it('저장 사다리도 없으면 두 창은 실제 시간외 총잔량과 막대를 표시한다', async () => {
    const originalSeries = vi.mocked(useLiveSeries).getMockImplementation()!;
    const previousNow = mock.now;
    const api = vi.spyOn(await import('../../api/client'), 'apiCall').mockResolvedValue({ snapshot: null });
    mock.now = Date.UTC(2026, 9, 14, 6, 47);
    vi.mocked(useLiveSeries).mockImplementation(() => ({ ...originalSeries('005930', 'KRX'), latestOb: undefined,
      afterHours: [{ t_ms: mock.now, total_ask_qty: 879, total_bid_qty: 538 }],
    }));
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const win: WorkspaceWindow = { id: 'no-book', kind: 'book', group: 1, rect: { x: 0, y: 0, w: 560, h: 640 } };
      render(<QueryClientProvider client={client}>
        <div data-testid="no-book"><DataWindow win={win} symbol={{ code: '005930', name: '삼성전자' }} /></div>
        <div data-testid="no-book-order"><OrderWindow code="005930" name="삼성전자" /></div>
      </QueryClientProvider>);
      await waitFor(() => expect(api).toHaveBeenCalledOnce());
      for (const id of ['no-book', 'no-book-order']) {
        const strip = within(screen.getByTestId(id)).getByTestId('book-total-strip');
        expect(strip).toHaveTextContent('879시간외종가 · 15:47:00538');
        expect(within(strip).getByTestId('book-total-fill')).toHaveStyle({ gridTemplateColumns: '879fr 538fr' });
      }
    } finally {
      api.mockRestore(); mock.now = previousNow;
      vi.mocked(useLiveSeries).mockImplementation(originalSeries);
    }
  });

  it('우클릭 메뉴의 Esc는 창 복원 이벤트로 전파하지 않는다', () => {
    mock.orders = [order()]; show();
    const onGlobalEscape = vi.fn(); window.addEventListener('keydown', onGlobalEscape);
    try {
      const chip = screen.getByLabelText('매수 67,200원 주문', { exact: true });
      fireEvent.contextMenu(chip.closest('.order-ladder')!, { clientX: 100, clientY: 100 });
      fireEvent.keyDown(chip, { key: 'Escape' });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
      expect(onGlobalEscape).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', onGlobalEscape); }
  });

});
