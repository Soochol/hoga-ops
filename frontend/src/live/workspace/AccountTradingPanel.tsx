import type { TradingAccountId } from '../../api/trading';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { nanoid } from 'nanoid';
import { tradingCommand, useTradingAccountList, type TossOrder, type TradingCommand, type TradingCommandResponse, type TradingHolding, type TradingSide } from '../../api/trading';
import { pauseTradingRefresh } from '../../api/tradingRefresh';
import { useQuoteByCode } from '../../api/liveQuotes';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useSymbols } from '../../capture/useSymbols';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';
import { RefreshIcon } from '../../ui/RefreshIcon';
import { OrderSurfaceHeading } from './OrderSurface';
import { useAccountOrderColumns } from './useAccountOrderColumns';
import { editableOrder, holdingProfitPercent, holdingProfitWon, orderRemainder, orderSideLabel, orderStatusLabel } from './orderRules';
import './AccountTradingPanel.css';

export type AccountListTab = 'orders' | 'holdings';
type Cancellation = { command: TradingCommand; sending: boolean; operationId?: string; error?: string };
const fmt = (value: string | number | null, maximumFractionDigits = 2) => value == null ? '—' : Number(value).toLocaleString('ko-KR', { maximumFractionDigits });

function holdingValue(quantity: string, price: number | undefined): number | null {
  const shares = Number(quantity);
  if (!Number.isSafeInteger(shares) || shares < 0 || price == null || !Number.isSafeInteger(price) || price <= 0) return null;
  const value = shares * price;
  return Number.isSafeInteger(value) ? value : null;
}

function HoldingsTable({ holdings, onSelect }: { holdings: TradingHolding[]; onSelect?: (code: string, name: string) => void }) {
  const venue = useLiveVenueStore(s => s.venue);
  const codes = useMemo(() => holdings.map(holding => holding.code), [holdings]);
  const quotes = useQuoteByCode(codes, venue);
  return <table className="account-holdings-table">
    <colgroup><col /><col /><col /><col /><col /></colgroup>
    <thead><tr><th>종목</th><th>수량</th><th>평단</th><th>평가금액</th><th>손익</th></tr></thead>
    <tbody>{holdings.map(holding => {
      const price = quotes.get(holding.code)?.price;
      const profitAmount = holdingProfitWon(Number(holding.quantity), price ?? null, holding.average_purchase_price);
      const profitPercent = holdingProfitPercent(Number(holding.quantity), price ?? null, holding.average_purchase_price);
      const profitDirection = profitAmount || profitPercent || 0;
      return <tr key={holding.code}>
        <td><button type="button" className="account-stock-link" disabled={!onSelect} onClick={() => onSelect?.(holding.code, holding.name)}>{holding.name}</button></td>
        <td data-label="수량">{fmt(holding.quantity)}</td><td data-label="평단">{fmt(holding.average_purchase_price, 0)}</td>
        <td data-label="평가금액">{fmt(holdingValue(holding.quantity, price), 0)}</td>
        <td data-label="손익" className={`account-holding-profit ${profitDirection > 0 ? 'text-price-up' : profitDirection < 0 ? 'text-price-down' : ''}`}>
          <span>{profitAmount == null ? '—' : `${profitAmount > 0 ? '+' : ''}${fmt(profitAmount, 0)}원`}</span>
          <span className="account-holding-profit-percent">{profitPercent == null ? '—' : `${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%`}</span>
        </td>
      </tr>;
    })}</tbody>
  </table>;
}

export const AccountTradingPanel = memo(function AccountTradingPanel({ account, accountLabel, orderEnabled = true, tab, anchorRef, onClose, onSelectSymbol }: {
  account: TradingAccountId; accountLabel: string; tab: AccountListTab | null; anchorRef: RefObject<HTMLElement | null>;
  orderEnabled?: boolean;
  onClose: () => void; onSelectSymbol?: (code: string, name: string) => void;
}) {
  const client = useQueryClient();
  const { orders, holdings, paused } = useTradingAccountList(account, tab);
  const symbols = useSymbols();
  const names = useMemo(() => new Map(symbols.data?.symbols.map(symbol => [symbol.code, symbol.name])), [symbols.data]);
  const nameOf = (code: string) => names.get(code) ?? code;
  const [side, setSide] = useState<TradingSide | null>(null);
  const [cancellations, setCancellations] = useState<Record<string, Cancellation>>({});
  const inFlight = useRef(new Set<string>());
  const [notice, setNotice] = useState<string | null>(null);
  const open = tab !== null;
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const dismiss = useCallback(() => {
    onClose();
    anchorRef.current?.querySelector<HTMLElement>('[aria-expanded="true"]')?.focus({ preventScroll: true });
  }, [onClose, anchorRef]);
  const { ref, style } = useAnchoredPopover<HTMLDivElement>(open, anchorRef, dismiss, 520);

  async function cancel(order: TossOrder, retry: boolean) {
    if (inFlight.current.has(order.orderId) || paused || !orderEnabled) return;
    const previous = cancellations[order.orderId];
    const command = retry && previous ? previous.command : { account_seq: account, code: order.symbol, command_id: nanoid() };
    inFlight.current.add(order.orderId);
    setCancellations(current => ({ ...current, [order.orderId]: { command, sending: true } }));
    setNotice(null);
    const resume = pauseTradingRefresh(client, 'live', account);
    try {
      const result = await tradingCommand<TradingCommandResponse>(`/orders/${encodeURIComponent(order.orderId)}/cancel`, command, 'live');
      setCancellations(current => ({ ...current, [order.orderId]: { command, sending: false, operationId: result.order_id } }));
      setNotice(`${nameOf(order.symbol)} 취소 요청 접수됨`);
    } catch (error) {
      setCancellations(current => ({ ...current, [order.orderId]: { command, sending: false,
        error: error instanceof Error ? error.message : '취소 결과를 확인하세요.' } }));
    } finally {
      inFlight.current.delete(order.orderId);
      resume();
    }
  }
  const allOrders = orders.data?.orders ?? [];
  const { setProbe, samples, style: columnStyle } = useAccountOrderColumns(account,
    allOrders.map(order => fmt(order.price)), allOrders.map(order => fmt(orderRemainder(order))));
  function select(code: string, name: string) { onClose(); onSelectSymbol?.(code, name); }
  if (tab === null) return null;
  const query = tab === 'orders' ? orders : holdings;
  const displayedOrders = allOrders.filter(order => side === null || order.side === side);
  const title = tab === 'orders' ? '미체결 주문' : '보유종목';
  return createPortal(<div ref={ref} style={{ ...style, ...columnStyle }} role="dialog" aria-label="계좌 목록" aria-description={accountLabel} className={`account-trading-panel order-surface font-data ${tab === 'orders' ? 'account-trading-orders' : ''}`}>
    <OrderSurfaceHeading closeLabel="계좌 목록 닫기" onClose={dismiss} actions={<>
      {tab === 'orders' && <div role="group" aria-label="주문 방향 필터" className="account-trading-filters order-surface-segment">
        {([null, 'BUY', 'SELL'] as const).map(value => <button key={value ?? 'all'} type="button" aria-pressed={side === value}
          onClick={() => setSide(value)}>{value === null ? '전체' : orderSideLabel(value)}</button>)}
      </div>}
      <button type="button" className="order-surface-icon" aria-label="새로고침" disabled={paused || query.isFetching} onClick={() => void query.refetch()}>
        <RefreshIcon className={query.isFetching ? 'w-[1em] h-[1em] motion-safe:animate-spin' : 'w-[1em] h-[1em]'} />
      </button>
    </>}>{title}</OrderSurfaceHeading>
    {paused && <p role="status" className="account-trading-message">조회 일시 중지</p>}
    {query.isError && <p role="alert" className="account-trading-message text-error">{query.error instanceof Error ? query.error.message : '계좌 목록 조회 실패'}</p>}
    {query.isPending && <p role="status" className="account-trading-message">목록 불러오는 중…</p>}
    {notice && <p role="status" className="account-trading-message">{notice}</p>}
    <div role="region" aria-label={tab === 'orders' ? '미체결 주문 목록' : '보유종목 목록'} className="account-trading-scroll">
      {tab === 'orders' && <span ref={setProbe} aria-hidden="true" className="account-orders-sizer">
        <span data-order-measure="price" className="account-order-heading-probe" data-figure="가격" />
        {samples.price.map(value => <span key={value} data-order-measure="price" data-figure={value} />)}
        <span data-order-measure="quantity" className="account-order-heading-probe" data-figure="잔여" />
        {samples.quantity.map(value => <span key={value} data-order-measure="quantity" data-figure={value} />)}
        {['매수', '매도'].map(value => <span key={value} data-order-measure="side" data-figure={value} />)}
        {['취소', '취소 중', '확인 중', '재확인'].map(value => <span key={value} data-order-measure="cancel" className="account-order-cancel-probe" data-figure={value} />)}
      </span>}
      {tab === 'orders' ? <table className="account-orders-table">
        <colgroup><col /><col /><col /><col /><col /></colgroup>
        <thead><tr><th>종목</th><th>구분</th><th>가격</th><th>잔여</th><th><span className="sr-only">취소</span></th></tr></thead>
        <tbody>{displayedOrders.map((order, index) => {
          const record = cancellations[order.orderId];
          const rejected = record?.operationId && orders.data?.recent_orders.some(item => item.orderId === record.operationId && item.status === 'CANCEL_REJECTED');
          const pending = !!record?.operationId && !rejected;
          const disabled = !orderEnabled || paused || !!record?.sending || (!record?.error && (orders.isError || !editableOrder(order) || pending || orderRemainder(order) <= 0));
          const label = record?.error ? '재확인' : record?.sending ? '취소 중' : pending ? '확인 중' : '취소';
          const name = nameOf(order.symbol);
          return <tr key={order.orderId} className={order.side === 'BUY' ? 'account-order-buy' : 'account-order-sell'}>
            <td><button type="button" className="account-stock-link" disabled={!onSelectSymbol} onClick={() => select(order.symbol, name)}>{name}</button>
              {record?.error ? <span role="alert" className="account-row-error">{record.error}</span>
                : !editableOrder(order) && <small>{orderStatusLabel(order.status)}</small>}</td>
            <td>{orderSideLabel(order.side)}</td><td>{fmt(order.price)}</td><td>{fmt(orderRemainder(order))}</td>
            <td><button type="button" className="account-cancel" aria-label={`${name} ${orderSideLabel(order.side)} 주문 ${index + 1} ${label}`} disabled={disabled} onClick={() => void cancel(order, !!record?.error)}>{label}</button></td>
          </tr>;
        })}</tbody>
      </table> : <HoldingsTable holdings={holdings.data?.holdings ?? []} onSelect={onSelectSymbol ? select : undefined} />}
      {!query.isPending && !query.isError && (tab === 'orders' ? displayedOrders.length === 0 : holdings.data?.holdings.length === 0)
        && <p className="account-trading-message">{tab === 'orders' ? '미체결 주문 없음' : '보유종목 없음'}</p>}
    </div>
  </div>, document.body);
});
