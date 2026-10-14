import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TossOrder } from '../../api/trading';
import { OrderWindow } from './OrderWindow';
import { DataWindow } from './DataWindow';
import type { WorkspaceWindow } from '../../state/workspace';
import { groupPriceOrders, holdingProfitWon, holdingPurchaseAmountWon, orderRemainder } from './orderRules';
import { useLiveVenueStore, type LiveVenueOption } from '../../state/liveVenue';
import { useLiveSeries } from '../../api/liveSeries';
import { useQuoteByCode } from '../../api/liveQuotes';
import { useLiveViStatus } from '../../api/liveViStatus';

const mock = vi.hoisted(() => ({ configured: true, accountCount: 1, priceOffset: 0, quotePrice: 67200 as number | null, buyingPower: '50000000', averagePrice: '66000', now: 1791856800000, snapshotAt: 1791856800000, orders: [] as TossOrder[], command: vi.fn() }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
afterAll(() => vi.unstubAllGlobals());
vi.mock('../../api/trading', () => ({
  useTradingAccounts: () => ({ data: { configured: mock.configured, accounts: mock.configured ? Array.from({ length: mock.accountCount }, (_, index) => ({ account_seq: index + 1, label: `계좌 ${index + 1}` })) : [] }, isLoading: false }),
  useTradingState: () => ({ data: mock.configured ? { account_seq: 1, code: '005930', orders: mock.orders, recent_orders: [], buying_power: mock.buyingPower, sellable_quantity: '80', holding_quantity: '100', average_purchase_price: mock.averagePrice, fetched_at_ms: mock.now, events_connected: true, unresolved_commands: [] } : undefined }),
  tradingCommand: (...args: unknown[]) => mock.command(...args),
}));
vi.mock('../../api/liveSeries', () => ({ useLiveSeries: vi.fn(() => ({ ob: [], latestOb: { t_ms: mock.snapshotAt, asks: Array.from({ length: 10 }, (_, i) => ({ price: 67300 + mock.priceOffset + i * 100, qty: 100 + i })), bids: Array.from({ length: 10 }, (_, i) => ({ price: 67200 + mock.priceOffset - i * 100, qty: 200 + i })), total_ask_qty: 1000, total_bid_qty: 2000 }, trade: [], afterHours: [] })) }));
vi.mock('../../api/liveQuotes', () => ({ useQuoteByCode: vi.fn(() => new Map([['005930', { price: mock.quotePrice, baseline_price: 66000, open: 68000, high: 69000, low: 67000, volume: 8336637, trade_value: 12290807000000, vs_prev_volume_pct: 184.55 }]])) }));
vi.mock('../../api/liveStockLimits', () => ({ useLiveStockLimits: () => ({ data: { base_price: 66000, upper_limit: 85800, lower_limit: 46200, high_250: 70000, low_250: 50000 } }) }));
vi.mock('../../api/liveKrxClose', () => ({ useLiveKrxClose: () => ({ data: { date: '20261013', price: 67100 } }) }));
vi.mock('../../api/liveViStatus', () => ({ useLiveViStatus: vi.fn(() => ({ data: { vi: null } })) }));
vi.mock('../../util/useWallClockSecond', () => ({ useWallClockSecond: () => mock.now }));
vi.mock('../useMinuteClock', () => ({ useMinuteClock: () => mock.now }));
const symbolMaster = vi.hoisted(() => ({ nxtEnabled: true as boolean | null }));
vi.mock('../../capture/useSymbols', () => ({ useSymbols: () => ({ data: { symbols: [{ code: '005930', nxt_enabled: symbolMaster.nxtEnabled }] } }) }));
vi.mock('../../api/liveAfterHoursBook', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/liveAfterHoursBook')>(), useAfterHoursBook: () => ({ data: undefined }),
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
beforeEach(() => { mock.orders = []; mock.configured = true; mock.accountCount = 1; mock.priceOffset = 0; mock.quotePrice = 67200; mock.buyingPower = '50000000'; mock.averagePrice = '66000'; mock.snapshotAt = mock.now; mock.command.mockReset().mockResolvedValue({ command_id: 'a', order_id: 'new', status: 'accepted' }); symbolMaster.nxtEnabled = true; useLiveVenueStore.setState({ venue: 'KRX' }); vi.mocked(useLiveSeries).mockClear(); vi.mocked(useQuoteByCode).mockClear(); vi.mocked(useLiveViStatus).mockClear(); });

describe('호가 주문', () => {
  it.each(['KRX', 'NXT', 'UN'] as const)('%s 시세를 조회해도 실계좌 주문 본문에는 거래소를 보내지 않는다', async venue => {
    useLiveVenueStore.setState({ venue });
    show();
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: 'live' } });
    expect(useLiveSeries).toHaveBeenLastCalledWith('005930', venue);
    expect(useQuoteByCode).toHaveBeenLastCalledWith(['005930'], venue);
    expect(useLiveViStatus).toHaveBeenLastCalledWith('005930', venue);
    expect(screen.getByLabelText('시세·주문 기준')).toHaveTextContent(`시세 ${venue === 'UN' ? '통합' : venue} · 주문 통합(SOR)`);
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0]).toEqual(['/orders', {
      account_seq: 1, command_id: expect.any(String), code: '005930', side: 'BUY', price: 67200,
      quantity: 10, confirm_high_value: false,
    }, 'live']);
  });
  it('통합 선택의 NXT 미상장 종목은 시세 KRX 대체와 모의 체결 기준을 표시한다', () => {
    symbolMaster.nxtEnabled = false;
    useLiveVenueStore.setState({ venue: 'UN' });
    show();
    expect(screen.getByLabelText('시세·주문 기준')).toHaveTextContent('시세 KRX (통합 선택) · 모의 체결 통합');
    expect(useLiveViStatus).toHaveBeenLastCalledWith('005930', 'KRX');
  });
  it('venue 전환은 가격 미리보기와 고액 확인을 닫고 주문 수량·계좌 주문을 유지한다', () => {
    mock.orders = [order()];
    show();
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: 'live' } });
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
  it.each(['paper', 'live'] as const)('%s 계좌의 매입수량 클릭은 전체 보유 수량을 채우고 다음 주문에 사용한다', async mode => {
    show();
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: mode } });
    fireEvent.click(screen.getByRole('button', { name: '매입수량' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(100);
    expect(mock.command).not.toHaveBeenCalled();
    const buy = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    await waitFor(() => expect(buy).toBeEnabled());
    fireEvent.doubleClick(buy);
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0]).toEqual(['/orders', expect.objectContaining({ quantity: 100 }), mode]);
  });
  it('금액 모드에서 매입수량을 클릭하면 수량 모드로 전환하고 보유 수량을 채운다', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '주문 설정' }));
    fireEvent.click(screen.getByRole('radio', { name: '금액' }));
    fireEvent.click(screen.getByRole('button', { name: '적용' }));
    fireEvent.click(screen.getByRole('button', { name: '매입수량' }));
    expect(screen.getByLabelText('신규 주문 수량')).toHaveValue(100);
    expect(screen.queryByLabelText('신규 주문 금액')).not.toBeInTheDocument();
    expect(screen.getByLabelText('예상 주문 금액')).toHaveTextContent('6,720,000원');
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
  it.each(['paper', 'live'] as const)('%s 계좌의 매수·매도는 단일 클릭으로 보내지 않고 더블클릭당 한 건만 보낸다', async mode => {
    show();
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: mode } });
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
      expect(mock.command.mock.calls[0]).toEqual(['/orders', expect.objectContaining({ side, price: 67200, quantity: 10 }), mode]);
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
    expect(field.textContent).toBe(value);
    expect(field.querySelector('.order-meta')).toBeNull();
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
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
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
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 68,000원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ side: 'BUY', price: 68000, quantity: 73 });
    const sell = screen.getByRole('button', { name: /매도 66,300원 주문 추가/ });
    await waitFor(() => expect(sell).toBeEnabled()); fireEvent.doubleClick(sell);
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
    expect(screen.getByLabelText('매입수량').textContent).toBe('100');
    expect(screen.getByLabelText('매입평단가').textContent).toBe('44,670');
    expect(screen.getByLabelText('보유 종목 평가 수익').textContent).toBe('2,253,004');
    expect(within(screen.getByRole('group', { name: '보유 종목 정보' })).getByLabelText('매입수량')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '주문 설정' }).nextElementSibling).toBe(screen.getByLabelText('매수 가능 금액'));
    expect(within(screen.getByRole('group', { name: '보유 종목 정보' })).queryByLabelText('매수 가능 금액')).not.toBeInTheDocument();
    for (const label of ['매입수량', '매입평단가', '평가수익', '예상금액', '주문수량']) expect(screen.queryByText(label, { exact: true })).not.toBeInTheDocument();
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
    expect(mock.command.mock.calls[0][2]).toBe('paper');
    expect(mock.command.mock.calls[0][1]).toMatchObject({ account_seq: 1, code: '005930', side: 'BUY', price: 67200, quantity: 10, confirm_high_value: false });
  });
  it('부분 체결을 제외한 잔량만 표시하고 클릭해도 하단 편집 UI가 열리지 않는다', () => {
    mock.orders = [order()]; show(); const chip = screen.getByLabelText('매수 67,200원 주문', { exact: true });
    expect(chip).toHaveTextContent('70주'); fireEvent.click(chip);
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
  it('모의 고액 주문은 즉시 보내고 실계좌의 필수 금액 확인만 유지한다', async () => {
    show(); fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '2000' } });
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
    expect(mock.command.mock.calls[0][1]).toMatchObject({ quantity: 2000, confirm_high_value: true });
    expect(screen.queryByRole('group', { name: '주문 확인' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: 'live' } });
    fireEvent.change(screen.getByLabelText('신규 주문 수량'), { target: { value: '2000' } });
    fireEvent.doubleClick(screen.getByRole('button', { name: /매수 67,200원 주문 추가/ }));
    expect(mock.command).toHaveBeenCalledOnce();
    expect(screen.getByRole('group', { name: '고액 주문 확인' })).toBeInTheDocument();
    expect(screen.queryByLabelText('주문 가격')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '확인 후 주문' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '1억원 이상 주문 금액을 확인했습니다' }));
    fireEvent.click(screen.getByRole('button', { name: '확인 후 주문' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1][2]).toBe('live');
  });
  it('같은 가격의 여러 주문은 한 칸에 합산하고 우클릭 목록에서 개별 잔량을 표시한다', () => {
    mock.orders = [order('a'), order('b'), { ...order('other'), price: '67100' }]; show();
    const cell = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    expect(cell).toHaveTextContent('140주');
    fireEvent.contextMenu(cell, { clientX: 100, clientY: 100 });
    const menu = screen.getByRole('menu', { name: '매수 67,200원 주문 목록' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    expect(within(menu).getByRole('menuitem', { name: '주문 1 · 70주 · a' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: '주문 2 · 70주 · b' })).toBeEnabled();
    expect(menu).not.toHaveTextContent('other');
    expect(mock.command).not.toHaveBeenCalled();
    const a = order(), b = { ...order('b'), side: 'SELL' as const }; expect(groupPriceOrders([a, b]).size).toBe(2); expect(orderRemainder(a)).toBe(70);
  });
  it('우클릭 목록의 처리 중 주문은 개별 드래그를 막고 Escape로 목록을 닫는다', () => {
    mock.orders = [order('a'), { ...order('b'), status: 'PENDING_CANCEL' }]; show();
    const cell = screen.getByRole('button', { name: /매수 67,200원 주문 추가/ });
    fireEvent.contextMenu(cell, { clientX: 100, clientY: 100 });
    const item = screen.getByRole('menuitem', { name: '주문 2 · 70주 · b' });
    expect(item).toBeDisabled();
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
  it('실계좌 선택 후에도 더블클릭으로 즉시 주문한다', async () => {
    show();
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: 'live' } });
    expect(screen.queryByRole('button', { name: '모의 계좌 설정' })).not.toBeInTheDocument();
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
    await screen.findByRole('combobox', { name: '주문 모드' });
    fireEvent.change(screen.getByRole('combobox', { name: '주문 모드' }), { target: { value: 'live' } });
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
    expect(strip).toHaveTextContent('1,000정규장2,000');
    expect(screen.getByLabelText('매도총잔량 1,000')).toHaveTextContent('1,000');
    expect(screen.getByLabelText('매수총잔량 2,000')).toHaveTextContent('2,000');
    expect(screen.getByTestId('book-total-fill')).toHaveStyle({ gridTemplateColumns: '1000fr 2000fr' });
    expect(strip).not.toHaveTextContent('매도 잔량'); expect(strip).not.toHaveTextContent('매수 잔량');
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
