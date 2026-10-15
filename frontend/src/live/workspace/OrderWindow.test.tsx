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
import { notifyOrderReceiptAccepted, playOrderReceiptSound, prepareOrderReceiptSound } from './orderReceiptSound';
import type { LiveAfterHoursBookResponse } from '../../api/liveAfterHoursBook';

vi.mock('./orderReceiptSound', () => ({
  notifyOrderReceiptAccepted: vi.fn(), playOrderReceiptSound: vi.fn(), prepareOrderReceiptSound: vi.fn(),
}));

const mock = vi.hoisted(() => ({ configured: true, balancesError: false, accountCount: 1, holdingQuantity: '100', sellableQuantity: '80' as string | undefined, priceOffset: 0, quotePrice: 67200 as number | null, buyingPower: '50000000', averagePrice: '66000', now: 1791856800000, snapshotAt: 1791856800000, expectedPrice: 0, expectedQty: 0, askCount: 10, bidCount: 10, orders: [] as TossOrder[], command: vi.fn() }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
afterAll(() => vi.unstubAllGlobals());
vi.mock('../../api/trading', () => ({
  useTradingAccounts: () => ({ data: { configured: mock.configured, accounts: mock.configured ? Array.from({ length: mock.accountCount }, (_, index) => ({ account_seq: index + 1, label: `계좌 ${index + 1}` })) : [] }, isLoading: false }),
  useTradingState: () => ({ balancesError: mock.balancesError, data: mock.configured ? { account_seq: 1, code: '005930', orders: mock.orders, recent_orders: [], buying_power: mock.buyingPower, sellable_quantity: mock.sellableQuantity, holding_quantity: mock.holdingQuantity, average_purchase_price: mock.averagePrice, fetched_at_ms: mock.now, events_connected: true, unresolved_commands: [] } : undefined }),
  useTradingAccountList: () => ({ orders: { data: undefined }, holdings: { data: undefined }, paused: false }),
  tradingCommand: (...args: unknown[]) => mock.command(...args),
}));
vi.mock('../../api/liveSeries', () => ({ useLiveSeries: vi.fn(() => ({ ob: [], latestOb: { t_ms: mock.snapshotAt, asks: Array.from({ length: 10 }, (_, i) => i < mock.askCount ? { price: 67300 + mock.priceOffset + i * 100, qty: 100 + i } : { price: 0, qty: 0 }), bids: Array.from({ length: 10 }, (_, i) => i < mock.bidCount ? { price: 67200 + mock.priceOffset - i * 100, qty: 200 + i } : { price: 0, qty: 0 }), total_ask_qty: 1000, total_bid_qty: 2000, expected_price: mock.expectedPrice, expected_qty: mock.expectedQty }, trade: [], afterHours: [] })) }));
vi.mock('../../api/liveQuotes', () => ({ useQuoteByCode: vi.fn(() => new Map([['005930', { price: mock.quotePrice, baseline_price: 66000, open: 68000, high: 69000, low: 67000, volume: 8336637, trade_value: 12290807000000, vs_prev_volume_pct: 184.55 }]])) }));
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
  fireEvent.click(screen.getByRole('checkbox', { name: '주문접수 소리' }));
  fireEvent.click(screen.getByRole('button', { name: '적용' }));
}
beforeEach(() => {
  afterHoursBook.data = undefined;
  vi.mocked(notifyOrderReceiptAccepted).mockReset();
  vi.mocked(prepareOrderReceiptSound).mockReset();
  vi.mocked(playOrderReceiptSound).mockReset().mockResolvedValue(true);
});
beforeEach(() => { mock.sellableQuantity = '80'; mock.holdingQuantity = '100'; mock.orders = []; mock.configured = true; mock.balancesError = false; mock.accountCount = 1; mock.priceOffset = 0; mock.quotePrice = 67200; mock.buyingPower = '50000000'; mock.averagePrice = '66000'; mock.snapshotAt = mock.now; mock.expectedPrice = 0; mock.expectedQty = 0; mock.askCount = 10; mock.bidCount = 10; mock.command.mockReset().mockResolvedValue({ command_id: 'a', order_id: 'new', status: 'accepted' }); symbolMaster.nxtEnabled = true; useLiveVenueStore.setState({ venue: 'KRX' }); vi.mocked(useLiveSeries).mockClear(); vi.mocked(useQuoteByCode).mockClear(); vi.mocked(useLiveViStatus).mockClear(); });

describe('호가 주문', () => {
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
  it('소리 들어보기는 끄기 상태에서도 재생하고 설정 적용이나 주문은 하지 않는다', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    const checkbox = screen.getByRole('checkbox', { name: '주문접수 소리' });
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '소리 들어보기' }));
    await waitFor(() => expect(playOrderReceiptSound).toHaveBeenCalledOnce());
    expect(checkbox).not.toBeChecked();
    expect(mock.command).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    expect(screen.getByRole('checkbox', { name: '주문접수 소리' })).not.toBeChecked();
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
    fireEvent.doubleClick(screen.getByRole('button', { name: new RegExp(label) }));
    expect(prepareOrderReceiptSound).toHaveBeenCalledOnce();
    expect(notifyOrderReceiptAccepted).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: '주문 접수 알림' })).toHaveTextContent('주문 요청 중');
    await act(async () => resolve({ command_id: mock.command.mock.calls[0][1].command_id, order_id: 'new', status: 'accepted' }));
    expect(notifyOrderReceiptAccepted).toHaveBeenCalledExactlyOnceWith(1, mock.command.mock.calls[0][1].command_id);
    expect(screen.getByRole('status', { name: '주문 접수 알림' })).toHaveTextContent('주문 요청 접수됨');
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
  it('10호가창과 같은 예상 체결가·체결량을 사다리 위에 표시하고 갱신한다', () => {
    mock.expectedPrice = 241_000; mock.expectedQty = 6_140;
    const view = show();
    const banner = screen.getByTestId('book-expected-fill');
    expect(banner).toHaveTextContent('예상 체결가241,000원');
    expect(banner).toHaveTextContent('예상 체결량6,140');
    const ladder = screen.getByRole('region', { name: '실시간 호가 주문 사다리' });
    expect(banner.nextElementSibling).toBe(ladder);
    mock.expectedQty = 0;
    view.rerender(<QueryClientProvider client={new QueryClient()}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>);
    expect(screen.queryByTestId('book-expected-fill')).not.toBeInTheDocument();
  });
  it('예상 체결가·체결량을 제공하지 않으면 배너를 표시하지 않는다', () => {
    show();
    expect(screen.queryByTestId('book-expected-fill')).not.toBeInTheDocument();
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
  it('venue 전환은 가격 미리보기와 고액 확인을 닫고 주문 수량·계좌 주문을 유지한다', () => {
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
    expect(screen.getByLabelText('매입수량')).toHaveTextContent('보유63');
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(43);
    expect(mock.command).not.toHaveBeenCalled();
    const sellButton = screen.getByRole('button', { name: /매도 67,200원 주문 추가/ });
    await waitFor(() => expect(sellButton).toBeEnabled());
    fireEvent.doubleClick(sellButton);
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0]).toEqual(['/orders', expect.objectContaining({ side: 'SELL', quantity: 43 }), 'live']);
  });
  it('금액 모드에서 매입수량을 클릭하면 수량 모드로 전환하고 매도 가능 수량을 채운다', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '금액' }));
    fireEvent.click(screen.getByRole('button', { name: '매입수량' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(80);
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
    mock.averagePrice = '70304.99999';
    show();
    const toggle = screen.getByRole('button', { name: '평가손익 표시 전환' });
    expect(toggle).toHaveTextContent('-310,499');
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent('-310,499');
    fireEvent.doubleClick(toggle);
    expect(toggle).toHaveTextContent('-4.42%');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle.querySelector('.order-field-value')).toHaveClass('text-price-down');
    fireEvent.doubleClick(toggle);
    expect(toggle).toHaveTextContent('-310,499');
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('수익률 표시는 시세 갱신을 따르고 종목 변경 후에도 유지한다', () => {
    const view = show();
    const toggle = () => screen.getByRole('button', { name: '평가손익 표시 전환' });
    fireEvent.keyDown(toggle(), { key: 'Enter' });
    expect(toggle()).toHaveTextContent('1.82%');
    mock.quotePrice = 65700;
    view.rerender(<QueryClientProvider client={new QueryClient()}><OrderWindow code="005930" name="삼성전자" /></QueryClientProvider>);
    expect(toggle()).toHaveTextContent('-0.45%');
    fireEvent.keyDown(toggle(), { key: ' ' });
    expect(toggle()).toHaveTextContent('-30,000');
    fireEvent.keyDown(toggle(), { key: 'Enter' });
    view.rerender(<QueryClientProvider client={new QueryClient()}><OrderWindow code="000660" name="SK하이닉스" /></QueryClientProvider>);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(mock.command).not.toHaveBeenCalled();
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
    expect(field.querySelector('.order-meta')).toHaveTextContent('평가손익');
  });
  it('상단에서 금액·수량을 바로 전환해도 각 입력값을 유지하고 전환만으로 주문하지 않는다', async () => {
    show();
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '37' } });
    const mode = within(screen.getByRole('group', { name: '주문 입력 방식' }));
    fireEvent.click(mode.getByRole('button', { name: '금액' }));
    expect(screen.getByLabelText('신규 주문 금액')).toHaveValue(1);
    fireEvent.click(screen.getByRole('button', { name: '500만' }));
    fireEvent.click(mode.getByRole('button', { name: '수량' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(37);
    fireEvent.click(mode.getByRole('button', { name: '금액' }));
    expect(screen.getByLabelText('신규 주문 금액')).toHaveValue(5);
    expect(screen.getByLabelText('예상 주문 수량')).toHaveTextContent('74주');
    expect(mock.command).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ price: 67200, quantity: 74 });
  });
  it('미보유는 보유 0과 평단가·평가손익 없음으로 표시하며 보유 수량을 적용하지 않는다', () => {
    mock.holdingQuantity = '0'; show();
    expect(screen.getByLabelText('매입수량')).toHaveTextContent('보유0');
    expect(screen.getByLabelText('매입수량')).toBeDisabled();
    expect(screen.getByLabelText('매입평단가')).toHaveTextContent('평단가—');
    expect(screen.getByLabelText('보유 종목 평가 수익')).toHaveTextContent('평가손익—');
    expect(screen.getByRole('button', { name: '평가손익 표시 전환' })).toBeDisabled();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('평단가 표시 설정은 적용할 때만 바뀌고 취소·Escape는 편집을 버린다', () => {
    mock.averagePrice = '67000.1';
    const { container } = show();
    const settings = screen.getByRole('button', { name: '주문 설정' });
    const marker = () => container.querySelector('.order-average-marker');
    fireEvent.click(settings);
    const checkbox = screen.getByRole('checkbox', { name: '내 평단가 표시' });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(marker()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(marker()).not.toBeNull();
    fireEvent.click(settings);
    expect(screen.getByRole('checkbox', { name: '내 평단가 표시' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: '내 평단가 표시' }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: '주문 설정' }), { key: 'Escape' });
    fireEvent.click(settings);
    expect(screen.getByRole('checkbox', { name: '내 평단가 표시' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: '내 평단가 표시' }));
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(marker()).toBeNull();
    expect(screen.getByLabelText('매입평단가')).toHaveTextContent('67,001');
    expect(container.querySelector('[data-order-price="67000"] [data-price-badges]')).toHaveTextContent('저');
    fireEvent.click(screen.getByRole('button', { name: '금액' }));
    fireEvent.click(settings);
    expect(screen.getByRole('checkbox', { name: '내 평단가 표시' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: '내 평단가 표시' }));
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(marker()).not.toBeNull();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('평단가 표시 설정과 관계없이 범위 밖 안내 없이 상단 숫자를 유지한다', () => {
    show();
    expect(screen.queryByText('호가 범위 밖')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '내 평단가 표시' }));
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    expect(screen.queryByText('호가 범위 밖')).not.toBeInTheDocument();
    expect(screen.getByLabelText('매입평단가')).toHaveTextContent('66,000');
  });
  it('설정 취소는 프리셋을 바꾸지 않고 적용된 프리셋·단축키로 즉시 주문한다', async () => {
    const view = show();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    const dialog = screen.getByRole('dialog', { name: '주문 설정' });
    expect(within(dialog).queryByText('주문 방식')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: '주문 입력' }).querySelectorAll('input')).toHaveLength(6);
    expect(within(within(dialog).getByRole('region', { name: '호가 표시' })).getByRole('checkbox', { name: '내 평단가 표시' })).toBeChecked();
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
    expect(within(dialog).getAllByRole('spinbutton')).toHaveLength(6);
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
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ quantity: 75 });
  });
  it('금액은 백만원으로 입력하고 현재가가 아닌 클릭 호가로 양방향 주수를 계산한다', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '금액' }));
    expect(screen.getByLabelText('신규 주문 금액')).toHaveValue(1);
    fireEvent.click(screen.getByRole('button', { name: '500만' }));
    expect(screen.getByLabelText('예상 주문 수량')).toHaveTextContent('74주');
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 68,000원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ side: 'BUY', price: 68000, quantity: 73 });
    const sell = screen.getByRole('button', { name: /매도 66,300원 주문 추가/ });
    await waitFor(() => expect(sell).toBeEnabled()); fireEvent.doubleClick(sell);
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1][1]).toMatchObject({ side: 'SELL', price: 66300, quantity: 75 });
    fireEvent.click(screen.getByRole('button', { name: '수량' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(10);
  });
  it('금액이 1주 미만이면 예상 0주를 표시하고 신규 주문을 제한한다', () => {
    mock.priceOffset = 1400000; mock.quotePrice = 1467200; show();
    fireEvent.click(screen.getByRole('button', { name: '금액' }));
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
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('3,365,000원');
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
    expect(within(screen.getByRole('group', { name: '보유 종목 정보' })).queryByLabelText('매수 가능 금액')).not.toBeInTheDocument();
    for (const label of ['보유', '평단가', '평가손익']) expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '종목 상세 정보' }));
    const summary = within(screen.getByRole('dialog', { name: '종목 상세 정보' })).getByTestId('book-summary');
    const summaryContent = within(summary);
    expect(summaryContent.queryByText('매수 가능')).not.toBeInTheDocument();
    expect(summaryContent.queryByText('매도 가능')).not.toBeInTheDocument();
    for (const label of ['KRX종가', '상한가', '하한가', '상승VI', '하강VI', '250일']) expect(summaryContent.getByText(label)).toBeInTheDocument();
    expect(summaryContent.getByText('833만')).toBeInTheDocument();
    expect(summaryContent.getByText('184.55%')).toBeInTheDocument();
    expect(summaryContent.getByText('12조 2,908억')).toBeInTheDocument();
    expect(summaryContent.getByText('70,000/50,000')).toBeInTheDocument();
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
  it('반대 주문이 있으면 신규 매도 영역을 비활성화한다', () => {
    mock.orders = [order()]; show(); expect(screen.getByRole('button', { name: /매도 67,200원 주문 추가/ })).toBeDisabled();
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
    expect(screen.getByRole('button', { name: /매수 67,100원 주문 추가/ })).toBeDisabled();
    const chip = screen.getByLabelText('매수 67,200원 주문', { exact: true });
    expect(chip.closest('button')).toBeEnabled(); expect(chip).toHaveAttribute('data-drag-order', 'a');
    fireEvent.click(chip);
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    view.unmount(); mock.configured = false; show(); expect(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ })).toBeDisabled();
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
    expect(menu).toHaveTextContent('매수 · 67,200원');
    expect(menu).toHaveTextContent('총 140');
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
    expect(item.textContent).toBe('주문 270');
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('키보드 단축키는 주문을 전송하지 않고 수량 프리셋 선택만 유지한다', () => {
    mock.orders = [order()]; show();
    const chip = screen.getByLabelText('매수 67,200원 주문', { exact: true });
    fireEvent.click(chip);
    for (const key of ['ArrowUp', 'ArrowDown', 'Delete']) fireEvent.keyDown(chip, { key, ctrlKey: true });
    fireEvent.keyDown(chip, { key: 'Backspace', ctrlKey: true, shiftKey: true });
    expect(mock.command).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    fireEvent.keyDown(chip, { key: '2', ctrlKey: true }); expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(50);
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

  it('종목을 바꿔도 선택한 실계좌를 유지하고 이전 확인은 닫는다', async () => {
    mock.accountCount = 2; mock.orders = [order()];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const win: WorkspaceWindow = { id: 'order-context', kind: 'order', group: 1, rect: { x: 0, y: 0, w: 720, h: 720 } };
    const view = render(<QueryClientProvider client={client}><DataWindow win={win} symbol={{ code: '005930', name: '삼성전자' }} /></QueryClientProvider>);
    await screen.findByRole('combobox', { name: '주문 계좌' });
    fireEvent.change(screen.getByRole('combobox', { name: '주문 계좌' }), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('매수 67,200원 주문', { exact: true }));
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    mock.orders = [];
    view.rerender(<QueryClientProvider client={client}><DataWindow win={win} symbol={{ code: '000660', name: 'SK하이닉스' }} /></QueryClientProvider>);
    expect(screen.getByRole('combobox', { name: '주문 계좌' })).toHaveValue('2');
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0]).toEqual(['/orders', expect.objectContaining({ account_seq: 2, code: '000660' }), 'live']);
  });

  it('실패는 신규 확인창 없이 알리고 재확인은 같은 요청 ID를 사용한다', async () => {
    mock.command.mockRejectedValueOnce(new Error('주문 처리 결과 확인 필요'));
    show(); fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent('주문 처리 결과 확인 필요'));
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '주문 접수' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '같은 요청 다시 확인' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1]).toEqual(mock.command.mock.calls[0]);
  });
  it('하단 버튼 없이 우클릭 메뉴에서 전체 취소를 즉시 보낸다', async () => {
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

  it.each([true, false])('정규장 사다리 존재=%s여도 두 창은 저장 호가를 공유하고 15:59:50 수신 즉시 전환한다', async hasBook => {
    const originalSeries = vi.mocked(useLiveSeries).getMockImplementation()!;
    const api = vi.spyOn(await import('../../api/client'), 'apiCall');
    const previousNow = mock.now;
    mock.now = Date.UTC(2026, 9, 14, 6, 47); // 15:47 KST
    vi.mocked(useLiveSeries).mockImplementation(() => ({ ...originalSeries('005930', 'KRX'),
      latestOb: hasBook ? { t_ms: Date.UTC(2026, 9, 14, 6, 30), asks: [{ price: 241500, qty: 0 }],
        bids: [{ price: 241000, qty: 0 }], total_ask_qty: 0, total_bid_qty: 0 } : undefined,
      afterHours: [{ t_ms: mock.now, total_ask_qty: 879, total_bid_qty: 538 }],
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
      await waitFor(() => expect(screen.getAllByText(/정규장 마지막 · 15:19:50/)).toHaveLength(2));
      for (const id of ['close-book', 'close-order']) {
        const strip = within(screen.getByTestId(id)).getByTestId('book-total-strip');
        expect(strip).toHaveTextContent('1,000정규장 마지막 · 15:19:502,000');
        expect(within(strip).getByTestId('book-total-fill')).toHaveStyle({ gridTemplateColumns: '1000fr 2000fr' });
      }
      expect(api).toHaveBeenCalledTimes(1);
      expect(new URL(api.mock.calls[0][0], 'http://test').searchParams.get('t')).toBe(String(Date.UTC(2026, 9, 14, 6, 20) - 1));
      const frozenBuy = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
      expect(frozenBuy).toBeDisabled();
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
        expect(strip).toHaveTextContent('879시간외종가538');
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
