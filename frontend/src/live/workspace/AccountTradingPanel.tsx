import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { nanoid } from 'nanoid';
import { tradingCommand, useTradingAccountList, type TossOrder, type TradingCommand, type TradingCommandResponse, type TradingSide } from '../../api/trading';
import { pauseTradingRefresh } from '../../api/tradingRefresh';
import { useSymbols } from '../../capture/useSymbols';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';
import { editableOrder, orderRemainder, orderSideLabel, orderStatusLabel } from './orderRules';
import './AccountTradingPanel.css';

export type AccountListTab = 'orders' | 'holdings';
type Cancellation = { command: TradingCommand; sending: boolean; operationId?: string; error?: string };
const fmt = (value: string | number | null) => value == null ? '—' : Number(value).toLocaleString('ko-KR', { maximumFractionDigits: 2 });

export const AccountTradingPanel = memo(function AccountTradingPanel({ account, accountLabel, tab, anchorRef, onTabChange, onClose, onSelectSymbol }: {
  account: number; accountLabel: string; tab: AccountListTab | null; anchorRef: RefObject<HTMLElement | null>;
  onTabChange: (tab: AccountListTab) => void; onClose: () => void; onSelectSymbol?: (code: string, name: string) => void;
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
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const dismiss = useCallback(() => {
    onClose();
    anchorRef.current?.querySelector<HTMLElement>('[aria-expanded="true"]')?.focus({ preventScroll: true });
  }, [onClose, anchorRef]);
  const { ref, style } = useAnchoredPopover<HTMLDivElement>(tab !== null, anchorRef, dismiss, 540);

  async function cancel(order: TossOrder, retry: boolean) {
    if (inFlight.current.has(order.orderId) || paused) return;
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
  function select(code: string, name: string) { onClose(); onSelectSymbol?.(code, name); }
  if (tab === null) return null;
  const query = tab === 'orders' ? orders : holdings;
  const displayedOrders = orders.data?.orders.filter(order => side === null || order.side === side) ?? [];
  return createPortal(<div ref={ref} style={style} role="dialog" aria-label="계좌 목록" className="account-trading-panel font-data">
    <div className="account-trading-heading">
      <div role="tablist" aria-label="계좌 목록 종류">
        <button type="button" role="tab" aria-selected={tab === 'orders'} onClick={() => onTabChange('orders')}>미체결 주문</button>
        <button type="button" role="tab" aria-selected={tab === 'holdings'} onClick={() => onTabChange('holdings')}>보유종목</button>
      </div>
      <button type="button" aria-label="계좌 목록 닫기" onClick={dismiss}>닫기</button>
    </div>
    <div className="account-trading-toolbar"><span>{accountLabel}</span>
      <button type="button" disabled={paused || query.isFetching} onClick={() => void query.refetch()}>새로고침</button>
    </div>
    {tab === 'orders' && <div role="group" aria-label="주문 방향 필터" className="account-trading-filters">
      {([null, 'BUY', 'SELL'] as const).map(value => <button key={value ?? 'all'} type="button" aria-pressed={side === value}
        onClick={() => setSide(value)}>{value === null ? '전체' : orderSideLabel(value)}</button>)}
    </div>}
    {query.isError && <p role="alert" className="account-trading-message text-error">{query.error instanceof Error ? query.error.message : '계좌 목록 조회 실패'}</p>}
    {query.isPending && <p role="status" className="account-trading-message">목록 불러오는 중…</p>}
    {notice && <p role="status" className="account-trading-message">{notice}</p>}
    <div role="tabpanel" aria-label={tab === 'orders' ? '미체결 주문 목록' : '보유종목 목록'} className="account-trading-scroll">
      {tab === 'orders' ? <table>
        <thead><tr><th>종목</th><th>구분</th><th>주문 가격</th><th>잔여 수량</th><th>취소</th></tr></thead>
        <tbody>{displayedOrders.map((order, index) => {
          const record = cancellations[order.orderId];
          const rejected = record?.operationId && orders.data?.recent_orders.some(item => item.orderId === record.operationId && item.status === 'CANCEL_REJECTED');
          const pending = !!record?.operationId && !rejected;
          const disabled = paused || !!record?.sending || (!record?.error && (orders.isError || !editableOrder(order) || pending || orderRemainder(order) <= 0));
          const label = record?.error ? '재확인' : record?.sending ? '취소 중' : pending ? '확인 중' : '취소';
          const name = nameOf(order.symbol);
          return <tr key={order.orderId} className={order.side === 'BUY' ? 'account-order-buy' : 'account-order-sell'}>
            <td><button type="button" className="account-stock-link" disabled={!onSelectSymbol} onClick={() => select(order.symbol, name)}>{name}</button>
              <small>{order.symbol}</small>{record?.error ? <span role="alert" className="account-row-error">{record.error}</span>
                : !editableOrder(order) && <small>{orderStatusLabel(order.status)}</small>}</td>
            <td>{orderSideLabel(order.side)}</td><td>{fmt(order.price)}</td><td>{fmt(orderRemainder(order))}</td>
            <td><button type="button" aria-label={`${name} ${orderSideLabel(order.side)} 주문 ${index + 1} ${label}`} disabled={disabled} onClick={() => void cancel(order, !!record?.error)}>{label}</button></td>
          </tr>;
        })}</tbody>
      </table> : <table>
        <thead><tr><th>종목</th><th>보유 수량</th><th>평균 매입가</th></tr></thead>
        <tbody>{holdings.data?.holdings.map(holding => <tr key={holding.code}>
          <td><button type="button" className="account-stock-link" disabled={!onSelectSymbol} onClick={() => select(holding.code, holding.name)}>{holding.name}</button><small>{holding.code}</small></td>
          <td>{fmt(holding.quantity)}</td><td>{fmt(holding.average_purchase_price)}</td>
        </tr>)}</tbody>
      </table>}
      {!query.isPending && !query.isError && (tab === 'orders' ? displayedOrders.length === 0 : holdings.data?.holdings.length === 0)
        && <p className="account-trading-message">{tab === 'orders' ? '미체결 주문 없음' : '보유종목 없음'}</p>}
    </div>
  </div>, document.body);
});
