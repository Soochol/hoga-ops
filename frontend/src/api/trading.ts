import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';
import { subscribeEvents } from './ws';

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
}
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
  useEffect(() => account > 0 ? subscribeEvents(event => {
    if (event.type === 'trading_changed' || event.type === 'connected') {
      void client.invalidateQueries({ queryKey: ['trading', mode, 'state', account] });
    }
  }) : undefined, [account, client, mode]);
  return useQuery({
    queryKey: ['trading', mode, 'state', account, code], enabled: account > 0,
    queryFn: ({ signal }) => apiCall<TradingStateResponse>(`${tradingPrefix(mode)}/state?account_seq=${account}&code=${encodeURIComponent(code)}`, { signal }),
    staleTime: 500, refetchInterval: 3_000, retry: false,
  });
}

export function tradingCommand<T>(path: string, body: TradingCommand, mode: TradingMode): Promise<T> {
  return apiCall<T>(`${tradingPrefix(mode)}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hoga-Order': '1' }, body: JSON.stringify(body),
  });
}
