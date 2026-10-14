import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';
import { subscribeEvents } from './ws';
import { applyTradingOrderEvent, mergeTradingOrderEvents, resetTradingOrderEvents, scheduleTradingRefresh,
  subscribeTradingRefresh, tradingRefreshPaused, tradingRefreshVersion, tradingStateKey } from './tradingRefresh';

export type TradingMode = 'paper' | 'live';
const tradingPrefix = (mode: TradingMode) => mode === 'paper' ? '/api/paper-trading' : '/api/trading';
export type TradingSide = 'BUY' | 'SELL';
export interface TossExecution {
  filledQuantity: string;
  averageFilledPrice: string | null;
  filledAmount: string | null;
  commission: string | null;
  tax: string | null;
  filledAt: string | null;
  settlementDate: string | null;
}
export interface TossOrder {
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
}
export interface TradingAccount { account_seq: number; label: string }
export interface TradingAccountsResponse { configured: boolean; accounts: TradingAccount[] }
export interface TradingStateResponse {
  account_seq: number;
  code: string;
  orders: TossOrder[];
  recent_orders: TossOrder[];
  buying_power: string;
  sellable_quantity: string;
  holding_quantity: string;
  average_purchase_price: string | null;
  fetched_at_ms: number;
  events_connected: boolean;
  unresolved_commands: string[];
  revision?: number;
}
export type OrderStateResponse = Pick<TradingStateResponse, 'account_seq' | 'code' | 'orders' | 'recent_orders' | 'fetched_at_ms' | 'events_connected' | 'unresolved_commands' | 'revision'>;
type BalancesResponse = Pick<TradingStateResponse, 'account_seq' | 'code' | 'buying_power' | 'sellable_quantity' | 'holding_quantity' | 'average_purchase_price' | 'fetched_at_ms'>;
export interface TradingCommand { account_seq: number; command_id: string; code: string }
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

export function useTradingAccounts(mode: TradingMode) {
  return useQuery({ queryKey: ['trading', mode, 'accounts'], queryFn: ({ signal }) =>
    apiCall<TradingAccountsResponse>(`${tradingPrefix(mode)}/accounts`, { signal }), staleTime: 60_000, retry: false });
}

export function useTradingState(account: number, code: string, mode: TradingMode) {
  const client = useQueryClient();
  const subscribe = useCallback((listener: () => void) => subscribeTradingRefresh(client, mode, account, listener), [client, mode, account]);
  const snapshot = useCallback(() => tradingRefreshVersion(client, mode, account), [client, mode, account]);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const paused = tradingRefreshPaused(client, mode, account);
  useEffect(() => account > 0 ? subscribeEvents(event => {
    if (event.type === 'trading_order' && event.mode === mode && event.account_seq === account) {
      const applied = applyTradingOrderEvent(client, mode, account, event.order, event.revision);
      scheduleTradingRefresh(client, mode, account, !applied);
      return;
    }
    if ((event.type === 'trading_changed' && (!event.mode || event.mode === mode)) || event.type === 'connected') {
      if (event.type === 'connected') resetTradingOrderEvents(client, mode, account);
      scheduleTradingRefresh(client, mode, account);
    }
  }) : undefined, [account, client, mode]);
  const path = `${tradingPrefix(mode)}/state?account_seq=${account}&code=${encodeURIComponent(code)}`;
  const orders = useQuery({
    queryKey: [...tradingStateKey(mode, account), 'orders', code], enabled: account > 0 && !paused,
    queryFn: ({ signal }) => apiCall<OrderStateResponse>(`${path}&part=orders`, { signal }),
    staleTime: 500, refetchInterval: 3_000, retry: false,
  });
  const balances = useQuery({
    queryKey: [...tradingStateKey(mode, account), 'balances', code], enabled: account > 0 && !paused,
    queryFn: ({ signal }) => apiCall<BalancesResponse>(`${path}&part=balances`, { signal }),
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

export function tradingCommand<T>(path: string, body: TradingCommand, mode: TradingMode): Promise<T> {
  return apiCall<T>(`${tradingPrefix(mode)}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hoga-Order': '1' }, body: JSON.stringify(body),
  });
}
