// useCursor + useSpot wiring. Each sidebar card subscribes to
// `tab.cursorMs` for the active tab and pulls spot data keyed by
// (tabId, endpoint, t). Trades pull the last N fills at-or-before the
// cursor via the backend's ?t= mode — a fixed-time-window query used to
// return empty arrays in low-volume minutes (e.g. mid-session lulls,
// auction edges), making the 체결 card read as broken when it was just
// sparse. "Last N before cursor" matches the UI's intent ("체결 흐름").
import { useShallow } from 'zustand/react/shallow';
import { useTabsStore } from '../state/tabs';
import { apiGet } from './client';
import { useSpot } from './useSpot';
import { unixMsToKSTDate } from '../util/time';
import { TIMEFRAME_TO_MS, type OrderbookResponse, type Timeframe, type Trade } from './types';

/**
 * Read the active tab's cursorMs (or null when no cursor set), plus the
 * Stock-Date that cursor falls into.
 *
 * `date` is derived from `cursorMs` (KST calendar day), NOT from
 * `selection.fromDate`. In a multi-day Stock-Date Range the chart's
 * right-edge cursor commonly lands on `toDate` or any day in between;
 * the API contract (per `hoga.api.cursor.cursor_to_native`) requires the
 * `date` query param to match the Stock-Date that `t` belongs to,
 * otherwise the endpoints reject with HTTPException(400). The prior
 * "fromDate is the active day" shortcut (Task 8.5, single-day only) was
 * not generalized when ADR-0013 introduced multi-day ranges, leaving the
 * 10호가 / 거래원 / 체결 cards stuck at "커서 위치 로딩 중…" because
 * `useSpot.catch` swallowed every 400 silently.
 */
export function useCursor(): {
  tabId: string;
  code: string | null;
  date: string | null;
  cursorMs: number | null;
  timeframe: Timeframe | null;
} {
  // useShallow keeps the object literal reference stable when the five
  // returned fields haven't changed. Without it, every unrelated store
  // update (settings toggles, MA pref changes, etc.) re-renders every
  // sidebar card subscribed via useCursor.
  return useTabsStore(
    useShallow((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      const cursorMs = tab?.cursorMs ?? null;
      return {
        tabId: tab?.id ?? '',
        code: tab?.selection?.code ?? null,
        date:
          cursorMs !== null && Number.isFinite(cursorMs)
            ? unixMsToKSTDate(cursorMs)
            : null,
        cursorMs,
        timeframe: tab?.selection?.timeframe ?? null,
      };
    }),
  );
}

export function useOrderbookAtCursor() {
  const { tabId, code, date, cursorMs, timeframe } = useCursor();
  // Align the sidebar 10호가 view with the QuoteTotalsPane indicator's
  // candle-close convention: passing `bucket_ms` tells the API to return the
  // LAST snapshot inside [t, t+bucket_ms) — the same snapshot the indicator
  // labels at the candle's bucket_start. Without this both views read the
  // same snapshots.parquet but disagreed by one candle (the indicator's
  // bucket-close vs query_at's "≤ t" = prior bucket's tail).
  // cursorMs is bucket-aligned by the chart's crosshair handler, but we
  // floor it defensively for the PriceStrip right-edge fallback path which
  // may write a mid-bucket ms. All ALLOWED_TIMEFRAME_MS values divide 1h,
  // so raw-unix flooring agrees with KST-relative bucketing.
  const bucketMs = timeframe !== null ? TIMEFRAME_TO_MS[timeframe] : null;
  const alignedT =
    cursorMs !== null && bucketMs !== null
      ? Math.floor(cursorMs / bucketMs) * bucketMs
      : cursorMs;
  const key =
    code && date && Number.isFinite(alignedT) && bucketMs !== null
      ? `${tabId}|ob|${code}|${date}|${alignedT}|${bucketMs}`
      : null;
  const { data } = useSpot(key, () =>
    apiGet<OrderbookResponse>(
      `/api/orderbook?code=${code}&date=${date}&t=${alignedT}&bucket_ms=${bucketMs}`,
    ).then((r) => r.snapshot),
  );
  // Preserve the (T | null | undefined) shape: undefined = haven't fetched
  // yet (no cursor / loading), null = fetched but empty, value = data.
  // Consumers distinguish loading vs no-data via the undefined check.
  return data;
}

export function useTradesAroundCursor(limit: number = 20) {
  const { tabId, code, date, cursorMs, timeframe } = useCursor();
  // Bucket-align the cursor before keying — matches useOrderbookAtCursor.
  // Without this, every pixel of crosshair movement produces a unique query
  // key, hammering /api/trades on drag/hover (measured: ~60 fetches/s during
  // a slow drag). Aligning collapses within-bucket motion to a single
  // request, since users only meaningfully reseat the cursor at bucket
  // boundaries anyway (FillTape's "last N at-or-before T" semantic).
  const bucketMs = timeframe !== null ? TIMEFRAME_TO_MS[timeframe] : null;
  const alignedT =
    cursorMs !== null && bucketMs !== null
      ? Math.floor(cursorMs / bucketMs) * bucketMs
      : cursorMs;
  const key =
    code && date && Number.isFinite(alignedT)
      ? `${tabId}|tr|${code}|${date}|${alignedT}|${limit}`
      : null;
  const { data } = useSpot(key, () =>
    apiGet<{ trades: Trade[] }>(
      `/api/trades?code=${code}&date=${date}&t=${alignedT}&limit=${limit}`,
    ).then((r) => r.trades),
  );
  // Preserve the (T | null | undefined) shape: undefined = haven't fetched
  // yet (no cursor / loading), null = fetched but empty, value = data.
  // Consumers distinguish loading vs no-data via the undefined check.
  return data;
}
