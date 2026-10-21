import { useEffect, useRef } from 'react';
import { normalizeBrokerOrder, type OrderStateResponse, type TossOrder, type TradingAccountId } from '../../api/trading';
import { subscribeEvents } from '../../api/ws';
import { notifyOrderFill } from './orderReceiptSound';

const fillStates = new Set(['PENDING', 'PARTIAL_FILLED', 'FILLED', 'PENDING_CANCEL', 'PENDING_REPLACE', 'CANCELED', 'REPLACED', 'EXPIRED']);

/** Establish a quiet baseline; only a higher cumulative fill is a new execution. */
export function createOrderFillTracker(startedAt: number, announce: (order: TossOrder, filled: number) => void) {
  const quantities = new Map<string, number>();
  let initialized = false;
  function observe(order: TossOrder, live: boolean, quiet = false) {
    if (!fillStates.has(order.status) || order.execution.filledQuantity == null) return;
    const filled = Number(order.execution.filledQuantity), quantity = Number(order.quantity);
    if (!Number.isSafeInteger(filled) || !Number.isSafeInteger(quantity) || filled < 0 || filled > quantity) return;
    const key = order.orderId;
    const prior = quantities.get(key);
    if (prior !== undefined && filled <= prior) return;
    quantities.set(key, filled);
    // REST may introduce older history. A previously unseen order needs a live event
    // or a timestamp proving it was created/filled after listening began.
    const fresh = live || Date.parse(order.orderedAt) >= startedAt || Date.parse(order.execution.filledAt ?? '') >= startedAt;
    if (!quiet && filled > (prior ?? 0) && (prior !== undefined || fresh)) announce(order, filled);
  }
  return {
    event: (order: TossOrder) => observe(order, true),
    snapshot: (state: OrderStateResponse) => {
      for (const order of [...state.orders, ...state.recent_orders]) observe(order, false, !initialized);
      initialized = true;
    },
  };
}

export function useOrderFillSound(account: TradingAccountId, code: string, state: OrderStateResponse | undefined,
  buyEnabled: boolean, sellEnabled: boolean) {
  const latest = useRef(state);
  latest.current = state;
  const tracker = useRef<ReturnType<typeof createOrderFillTracker> | null>(null);
  useEffect(() => {
    if (!account || (!buyEnabled && !sellEnabled)) return;
    const current = createOrderFillTracker(Date.now(), (order, filled) => {
      if ((order.side === 'BUY' && buyEnabled) || (order.side === 'SELL' && sellEnabled)) {
        notifyOrderFill(account, code, order.orderId, order.side, filled);
      }
    });
    tracker.current = current;
    if (latest.current) current.snapshot(latest.current);
    const unsubscribe = subscribeEvents(event => {
      if (event.type === 'trading_order' && event.mode === 'live' && event.account_seq === account && event.order.symbol === code) {
        current.event(event.order);
      } else if (event.type === 'trading_order_v2' && event.account_ref === account && event.order.code === code) {
        current.event(normalizeBrokerOrder(event.order));
      }
    });
    return () => { tracker.current = null; unsubscribe(); };
  }, [account, code, buyEnabled, sellEnabled]);
  useEffect(() => { if (state) tracker.current?.snapshot(state); }, [state]);
}
