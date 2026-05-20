// Task 8.5: useCursor + useSpot wiring. Each sidebar card subscribes to
// `tab.cursorMs` for the active tab and pulls spot data keyed by
// (tabId, endpoint, t). Trades pull a 5s look-back window of up to 20 fills.
import { useTabsStore } from '../state/tabs';
import { apiGet } from './client';
import { useSpot } from './useSpot';
import type { BrokerEntry, Trade } from './types';
import { reshapeOrderbook, type OrderbookResponse } from './adapters';

/** Read the active tab's cursorMs (or null when no cursor set). */
export function useCursor(): {
  tabId: string;
  code: string | null;
  date: string | null;
  cursorMs: number | null;
} {
  return useTabsStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return {
      tabId: tab?.id ?? '',
      code: tab?.selection?.code ?? null,
      // Task 8.5: single-day cursor for now — fromDate is the active day.
      date: tab?.selection?.fromDate ?? null,
      cursorMs: tab?.cursorMs ?? null,
    };
  });
}

export function useOrderbookAtCursor() {
  const { tabId, code, date, cursorMs } = useCursor();
  const key = code && date && cursorMs ? `${tabId}|ob|${code}|${date}|${cursorMs}` : null;
  const { data } = useSpot(key, () =>
    apiGet<OrderbookResponse>(`/api/orderbook?code=${code}&date=${date}&t=${cursorMs}`).then(
      reshapeOrderbook,
    ),
  );
  // Preserve the (T | null | undefined) shape: undefined = haven't fetched
  // yet (no cursor / loading), null = fetched but empty, value = data.
  // Consumers distinguish loading vs no-data via the undefined check.
  return data;
}

export function useBrokersAtCursor() {
  const { tabId, code, date, cursorMs } = useCursor();
  const key = code && date && cursorMs ? `${tabId}|br|${code}|${date}|${cursorMs}` : null;
  const { data } = useSpot(key, () =>
    apiGet<{ ts_ms: number | null; entries: BrokerEntry[] }>(
      `/api/brokers?code=${code}&date=${date}&t=${cursorMs}`,
    ).then((r) => r.entries),
  );
  // Preserve the (T | null | undefined) shape: undefined = haven't fetched
  // yet (no cursor / loading), null = fetched but empty, value = data.
  // Consumers distinguish loading vs no-data via the undefined check.
  return data;
}

export function useTradesAroundCursor(windowMs: number = 5000, limit: number = 20) {
  const { tabId, code, date, cursorMs } = useCursor();
  const key =
    code && date && cursorMs
      ? `${tabId}|tr|${code}|${date}|${cursorMs}|${windowMs}|${limit}`
      : null;
  const { data } = useSpot(key, () =>
    apiGet<{ trades: Trade[] }>(
      `/api/trades?code=${code}&date=${date}&from=${cursorMs! - windowMs}&to=${cursorMs}&limit=${limit}`,
    ).then((r) => r.trades),
  );
  // Preserve the (T | null | undefined) shape: undefined = haven't fetched
  // yet (no cursor / loading), null = fetched but empty, value = data.
  // Consumers distinguish loading vs no-data via the undefined check.
  return data;
}
