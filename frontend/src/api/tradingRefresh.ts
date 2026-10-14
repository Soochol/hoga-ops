import type { QueryClient } from '@tanstack/react-query';
import type { OrderStateResponse, TossOrder, TradingMode } from './trading';

type Refresh = {
  pending: number;
  listeners: Set<() => void>;
  ordersTimer?: ReturnType<typeof setTimeout>;
  balancesTimer?: ReturnType<typeof setTimeout>;
  lastBalancesAt: number;
  version: number;
  events: Map<string, { order: TossOrder; revision: number }>;
};
const clients = new WeakMap<QueryClient, Map<string, Refresh>>();
export const tradingStateKey = (mode: TradingMode, account: number) => ['trading', mode, 'state', account] as const;

function shared(client: QueryClient, mode: TradingMode, account: number): Refresh {
  let contexts = clients.get(client);
  if (!contexts) { contexts = new Map(); clients.set(client, contexts); }
  const key = `${mode}:${account}`;
  let refresh = contexts.get(key);
  if (!refresh) {
    refresh = { pending: 0, listeners: new Set(), lastBalancesAt: 0, version: 0, events: new Map() };
    contexts.set(key, refresh);
  }
  return refresh;
}

const openStates = new Set(['PENDING', 'PARTIAL_FILLED', 'PENDING_CANCEL', 'PENDING_REPLACE']);
const terminalStates = new Set(['FILLED', 'CANCELED', 'REPLACED', 'REJECTED', 'EXPIRED', 'CANCEL_REJECTED', 'REPLACE_REJECTED']);
function publish(refresh: Refresh) {
  refresh.version++;
  refresh.listeners.forEach(listener => listener());
}

/** Display-only merge. No command ever uses an event as its submission-time validation. */
export function mergeOrderSnapshot(previous: TossOrder | undefined, next: TossOrder, canonical = false): TossOrder | null {
  const quantity = Number(next.quantity), filled = Number(next.execution.filledQuantity);
  if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(filled) || quantity < 0 || filled < 0 || filled > quantity
    || (!openStates.has(next.status) && !terminalStates.has(next.status))) return null;
  if (!previous) return next;
  if (!openStates.has(previous.status) && !terminalStates.has(previous.status)) return null;
  if (previous.orderId !== next.orderId || previous.symbol !== next.symbol || previous.side !== next.side
    || previous.currency !== next.currency || Number(previous.quantity) !== quantity || previous.price !== next.price
    || filled < Number(previous.execution.filledQuantity)) return null;
  if (terminalStates.has(previous.status) && previous.status !== next.status) return null;
  const processing = ['PENDING_CANCEL', 'PENDING_REPLACE'].includes(previous.status);
  const status = !canonical && processing && ['PENDING', 'PARTIAL_FILLED'].includes(next.status) ? previous.status : next.status;
  return { ...next, status, execution: { ...next.execution, filledAt: next.execution.filledAt ?? previous.execution.filledAt } };
}

export function tradingRefreshVersion(client: QueryClient, mode: TradingMode, account: number) {
  return shared(client, mode, account).version;
}

export function resetTradingOrderEvents(client: QueryClient, mode: TradingMode, account: number) {
  const refresh = shared(client, mode, account);
  if (!refresh.events.size) return;
  // Reconcile active orders after reconnect, but never resurrect a known terminal ID.
  for (const [key, event] of refresh.events) {
    if (terminalStates.has(event.order.status)) refresh.events.set(key, { ...event, revision: -1 });
    else refresh.events.delete(key);
  }
  publish(refresh);
}

export function applyTradingOrderEvent(client: QueryClient, mode: TradingMode, account: number, order: TossOrder, revision: number) {
  const refresh = shared(client, mode, account);
  const key = `${order.symbol}:${order.orderId}`;
  const prior = refresh.events.get(key);
  if (prior && revision <= prior.revision) return true;
  const base = client.getQueryData<OrderStateResponse>([...tradingStateKey(mode, account), 'orders', order.symbol]);
  const previous = prior?.order ?? base?.orders.find(o => o.orderId === order.orderId)
    ?? base?.recent_orders.find(o => o.orderId === order.orderId);
  const merged = mergeOrderSnapshot(previous, order);
  if (!merged) return false;
  refresh.events.delete(key);
  refresh.events.set(key, { order: merged, revision });
  // Keep active orders, plus a bounded set of terminal tombstones against late REST reads.
  const terminals = [...refresh.events].filter(([, event]) => terminalStates.has(event.order.status));
  for (const [oldKey] of terminals.slice(0, -200)) refresh.events.delete(oldKey);
  publish(refresh);
  return true;
}

export function mergeTradingOrderEvents(client: QueryClient, mode: TradingMode, account: number, code: string,
  base: OrderStateResponse | undefined): OrderStateResponse | undefined {
  if (!base) return undefined;
  const events = [...shared(client, mode, account).events.values()].filter(event => event.order.symbol === code);
  if (!events.length) return base;
  const orders = new Map(base.orders.map(order => [order.orderId, order]));
  const recent = new Map([...base.recent_orders].reverse().map(order => [order.orderId, order]));
  for (const event of events) {
    const canonical = orders.get(event.order.orderId) ?? recent.get(event.order.orderId);
    if ((base.revision ?? -1) >= event.revision && canonical && mergeOrderSnapshot(event.order, canonical, true)) continue;
    const order = mergeOrderSnapshot(canonical, event.order) ?? canonical;
    if (!order) continue;
    if (terminalStates.has(order.status)) {
      orders.delete(order.orderId); recent.delete(order.orderId); recent.set(order.orderId, order);
    } else { orders.set(order.orderId, order); recent.delete(order.orderId); }
  }
  return { ...base, orders: [...orders.values()], recent_orders: [...recent.values()].reverse().slice(0, 10) };
}

export function tradingRefreshPaused(client: QueryClient, mode: TradingMode, account: number) {
  return shared(client, mode, account).pending > 0;
}

export function subscribeTradingRefresh(client: QueryClient, mode: TradingMode, account: number, listener: () => void) {
  const refresh = shared(client, mode, account);
  refresh.listeners.add(listener);
  return () => { refresh.listeners.delete(listener); };
}

export function scheduleTradingRefresh(client: QueryClient, mode: TradingMode, account: number, orders = true) {
  const refresh = shared(client, mode, account);
  if (account <= 0 || refresh.pending) return;
  const key = tradingStateKey(mode, account);
  // Each burst gets one refresh. Do not repeatedly abort an in-flight REST read.
  if (orders && refresh.ordersTimer === undefined) refresh.ordersTimer = setTimeout(() => {
    refresh.ordersTimer = undefined;
    if (refresh.pending) return;
    const orders = { queryKey: [...key, 'orders'] };
    if (client.isFetching(orders)) { scheduleTradingRefresh(client, mode, account); return; }
    void client.invalidateQueries(orders, { cancelRefetch: false });
  }, 80);
  if (refresh.balancesTimer === undefined) refresh.balancesTimer = setTimeout(() => {
    refresh.balancesTimer = undefined;
    if (refresh.pending) return;
    refresh.lastBalancesAt = Date.now();
    void client.invalidateQueries({ queryKey: [...key, 'balances'] }, { cancelRefetch: false });
  }, Math.max(400, refresh.lastBalancesAt + 2_000 - Date.now()));
}

/** All windows for this account pause background reads while a write/group is active. */
export function pauseTradingRefresh(client: QueryClient, mode: TradingMode, account: number) {
  const refresh = shared(client, mode, account);
  refresh.pending++;
  clearTimeout(refresh.ordersTimer); clearTimeout(refresh.balancesTimer);
  refresh.ordersTimer = undefined; refresh.balancesTimer = undefined;
  void client.cancelQueries({ queryKey: tradingStateKey(mode, account) });
  publish(refresh);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    refresh.pending--;
    if (refresh.pending) return;
    // Mark orders stale before enabling queries. Their refresh cannot hold up the ACK.
    void client.invalidateQueries({ queryKey: [...tradingStateKey(mode, account), 'orders'], refetchType: 'none' });
    publish(refresh);
    scheduleTradingRefresh(client, mode, account, false);
  };
}
