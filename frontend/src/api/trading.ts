import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall, type ApiError } from './client';
import { subscribeEvents } from './ws';
import { applyTradingOrderEvent, mergeTradingOrderEvents, resetTradingOrderEvents, scheduleTradingRefresh,
  subscribeTradingRefresh, tradingRefreshPaused, tradingRefreshVersion, tradingStateKey } from './tradingRefresh';

export type TradingMode = 'paper' | 'live';
export type TradingAccountId = number | string;
const tradingPrefix = (mode: TradingMode, account?: TradingAccountId) => mode === 'paper'
  ? '/api/paper-trading' : typeof account === 'string' ? '/api/trading/v2' : '/api/trading';
const accountParam = (account: TradingAccountId) => typeof account === 'string'
  ? `account_ref=${encodeURIComponent(account)}` : `account_seq=${account}`;
export type TradingSide = 'BUY' | 'SELL';
export interface TossExecution {
  filledQuantity: string | null;
  averageFilledPrice: string | null;
  filledAmount: string | null;
  commission: string | null;
  tax: string | null;
  filledAt: string | null;
  settlementDate: string | null;
}
export interface TradingOrder {
  orderId: string;
  symbol: string;
  side: TradingSide;
  orderType: string;
  timeInForce: string;
  status: string;
  price: string | null;
  quantity: string;
  orderAmount: string | null;
  currency: string;
  orderedAt: string;
  canceledAt: string | null;
  execution: TossExecution;
  remaining_quantity?: string;
  editable?: boolean;
}
export type TossOrder = TradingOrder;
export interface TradingAccount {
  account_seq: TradingAccountId; label: string; broker?: 'toss' | 'kiwoom'; environment?: 'real' | 'mock';
  routes?: ('KRX' | 'NXT' | 'SOR')[]; order_enabled?: boolean; blocked_reason?: string | null;
}
export interface TradingAccountsResponse { configured: boolean; accounts: TradingAccount[]; errors?: Record<string, string> }
export interface TradingStateResponse {
  account_seq: TradingAccountId;
  code: string;
  orders: TossOrder[];
  recent_orders: TossOrder[];
  buying_power: string | null;
  sellable_quantity: string | null;
  holding_quantity: string | null;
  average_purchase_price: string | null;
  fetched_at_ms: number;
  events_connected: boolean;
  unresolved_commands: string[];
  revision?: number;
}
export type OrderStateResponse = Pick<TradingStateResponse, 'account_seq' | 'code' | 'orders' | 'recent_orders' | 'fetched_at_ms' | 'events_connected' | 'unresolved_commands' | 'revision'>;
type BalancesResponse = Pick<TradingStateResponse, 'account_seq' | 'code' | 'buying_power' | 'sellable_quantity' | 'holding_quantity' | 'average_purchase_price' | 'fetched_at_ms'>;
export interface TradingCommand { account_seq: TradingAccountId; command_id: string; code: string; route?: 'KRX' | 'NXT' | 'SOR' }
export interface CreateTradingOrder extends TradingCommand {
  side: TradingSide; quantity: number; price: number; confirm_high_value: boolean;
}
export interface ModifyTradingOrder extends TradingCommand {
  price: number; quantity: number | null; confirm_high_value: boolean;
}
export interface CancelTradingOrders extends TradingCommand { side: TradingSide | null }
export interface TradingCommandResponse { command_id: string; order_id: string; status: string }
export interface TradingCancelResult { order_id: string; accepted: boolean; operation_id: string | null; code: string | null; message: string | null }
export interface TradingCancelResponse { results: TradingCancelResult[] }
export interface ReviewTradingCommand extends TradingCommand { confirmed: true }
export interface TradingReviewResponse { command_id: string }

export interface ResetPaperAccount extends TradingCommand {
  cash: number; holding_quantity: number; average_purchase_price: number; confirmed: true;
}

export interface BrokerOrderWire {
  order_ref: string; account_ref: string; code: string; side: TradingSide; order_type: string;
  status: string; price: string | null; quantity: string; remaining_quantity: string;
  filled_quantity: string | null; ordered_at: string | null; average_filled_price: string | null; editable: boolean;
}
export function normalizeBrokerOrder(order: BrokerOrderWire): TradingOrder {
  return { orderId: order.order_ref, symbol: order.code, side: order.side, orderType: order.order_type,
    timeInForce: 'DAY', status: order.status, price: order.price, quantity: order.quantity,
    remaining_quantity: order.remaining_quantity, editable: order.editable, orderAmount: null, currency: 'KRW',
    orderedAt: order.ordered_at ?? '', canceledAt: null, execution: { filledQuantity: order.filled_quantity,
      averageFilledPrice: order.average_filled_price, filledAmount: null, commission: null, tax: null,
      filledAt: null, settlementDate: null } };
}
type BrokerStateWire = Omit<OrderStateResponse, 'account_seq' | 'orders' | 'recent_orders'> & {
  account_ref: string; orders: BrokerOrderWire[]; recent_orders: BrokerOrderWire[];
};
export interface BrokerBalancesWire {
  account_ref: string; code: string; buying_power: string | null; buyable_quantity: string | null;
  sellable_quantity: string | null; holding_quantity: string | null; average_purchase_price: string | null;
  fetched_at_ms: number; capacity_status: 'available' | 'unavailable';
}
export type BrokerFullStateWire = BrokerStateWire & BrokerBalancesWire;
export interface BrokerHoldingsWire { account_ref: string; holdings: TradingHolding[]; fetched_at_ms: number }
export interface BrokerCommandStatusWire {
  command_id: string; state: string; result: Record<string, unknown> | null;
}
function normalizeState(value: OrderStateResponse | BrokerStateWire): OrderStateResponse {
  if (!('account_ref' in value)) return value;
  return { ...value, account_seq: value.account_ref, orders: value.orders.map(normalizeBrokerOrder),
    recent_orders: value.recent_orders.map(normalizeBrokerOrder) };
}
function normalizeAccount<T extends { account_seq: TradingAccountId }>(value: T | (Omit<T, 'account_seq'> & { account_ref: string })): T {
  return ('account_ref' in value ? { ...value, account_seq: value.account_ref } : value) as T;
}

export function useTradingAccounts(mode: TradingMode) {
  return useQuery({ queryKey: ['trading', mode, 'accounts'], queryFn: async ({ signal }) => {
    if (mode === 'paper') return apiCall<TradingAccountsResponse>('/api/paper-trading/accounts', { signal });
    try {
      const data = await apiCall<{ configured: boolean; accounts: (TradingAccount & { account_ref?: string })[]; errors?: Record<string, string> }>(
        '/api/trading/v2/accounts', { signal });
      return { ...data, accounts: data.accounts.map(account => ({ ...account,
        account_seq: account.account_ref ?? account.account_seq })) };
    } catch (error) {
      if ((error as ApiError).status !== 404) throw error;
      return apiCall<TradingAccountsResponse>('/api/trading/accounts', { signal });
    }
  }, staleTime: 60_000, retry: false });
}

function useTradingRefresh(account: TradingAccountId, mode: TradingMode, listen = true) {
  const client = useQueryClient();
  const subscribe = useCallback((listener: () => void) => subscribeTradingRefresh(client, mode, account, listener), [client, mode, account]);
  const snapshot = useCallback(() => tradingRefreshVersion(client, mode, account), [client, mode, account]);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const paused = tradingRefreshPaused(client, mode, account);
  useEffect(() => !!account && listen ? subscribeEvents(event => {
    if (mode === 'live' && event.type === 'trading_order_v2' && event.account_ref === account) {
      const applied = applyTradingOrderEvent(client, mode, account, normalizeBrokerOrder(event.order), event.revision);
      scheduleTradingRefresh(client, mode, account, !applied);
      return;
    }
    if (event.type === 'trading_changed_v2' && event.account_ref === account) {
      scheduleTradingRefresh(client, mode, account);
      return;
    }
    if (event.type === 'trading_order' && event.mode === mode && event.account_seq === account) {
      const applied = applyTradingOrderEvent(client, mode, account, event.order, event.revision);
      scheduleTradingRefresh(client, mode, account, !applied);
      return;
    }
    if ((event.type === 'trading_changed' && (!event.mode || event.mode === mode)) || event.type === 'connected') {
      if (event.type === 'connected') resetTradingOrderEvents(client, mode, account);
      scheduleTradingRefresh(client, mode, account);
    }
  }) : undefined, [account, client, mode, listen]);
  return { client, paused };
}

export function useTradingState(account: TradingAccountId, code: string, mode: TradingMode) {
  const { client, paused } = useTradingRefresh(account, mode);
  const path = `${tradingPrefix(mode, account)}/state?${accountParam(account)}&code=${encodeURIComponent(code)}`;
  const orders = useQuery({
    queryKey: [...tradingStateKey(mode, account), 'orders', code], enabled: !!account && !paused,
    queryFn: async ({ signal }) => normalizeState(await apiCall<OrderStateResponse | BrokerStateWire>(`${path}&part=orders`, { signal })),
    staleTime: 500, refetchInterval: 3_000, retry: false,
  });
  const balances = useQuery({
    queryKey: [...tradingStateKey(mode, account), 'balances', code], enabled: !!account && !paused,
    queryFn: async ({ signal }) => normalizeAccount(await apiCall<BalancesResponse>(`${path}&part=balances`, { signal })),
    staleTime: 10_000, refetchInterval: 10_000, retry: false,
  });
  const orderData = mergeTradingOrderEvents(client, mode, account, code, orders.data);
  return {
    data: orderData ? { ...balances.data, ...orderData } : undefined,
    isError: orders.isError,
    error: orders.error ?? balances.error,
    balancesError: balances.isError,
  };
}

export interface TradingHolding {
  code: string; name: string; quantity: string; average_purchase_price: string;
}
export interface TradingHoldingsResponse {
  account_seq: TradingAccountId; holdings: TradingHolding[]; fetched_at_ms: number;
}

/** Only the visible tab fetches; account-wide write coordination also pauses these queries. */
export function useTradingAccountList(account: TradingAccountId, tab: 'orders' | 'holdings' | null) {
  const { client, paused } = useTradingRefresh(account, 'live', tab !== null);
  const orders = useQuery({
    queryKey: [...tradingStateKey('live', account), 'orders', 'account'],
    enabled: !!account && tab === 'orders' && !paused,
    queryFn: async ({ signal }) => normalizeState(await apiCall<OrderStateResponse | BrokerStateWire>(
      `${tradingPrefix('live', account)}/account-orders?${accountParam(account)}`, { signal })),
    staleTime: 500, refetchInterval: tab === 'orders' ? 3_000 : false, retry: false,
  });
  const holdings = useQuery({
    queryKey: [...tradingStateKey('live', account), 'balances', 'holdings'],
    enabled: !!account && tab === 'holdings' && !paused,
    queryFn: async ({ signal }) => normalizeAccount(await apiCall<TradingHoldingsResponse>(`${tradingPrefix('live', account)}/holdings?${accountParam(account)}`, { signal })),
    staleTime: 10_000, refetchInterval: tab === 'holdings' ? 10_000 : false, retry: false,
  });
  return { orders: { ...orders, data: mergeTradingOrderEvents(client, 'live', account, null, orders.data) }, holdings, paused };
}

export async function tradingCommand<T>(path: string, body: TradingCommand, mode: TradingMode): Promise<T> {
  const { account_seq: account, ...fields } = body;
  const payload = typeof account === 'string' ? { ...fields, account_ref: account } : body;
  const result = await apiCall<T & { order_ref?: string; operation_ref?: string }>(`${tradingPrefix(mode, account)}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hoga-Order': '1' }, body: JSON.stringify(payload),
  });
  return result.order_ref ? { ...result, order_id: result.operation_ref ?? result.order_ref } : result;
}
