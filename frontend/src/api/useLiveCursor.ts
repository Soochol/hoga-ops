/**
 * Live-page cursor-keyed spot hooks (ADR-0044).
 *
 * Mirrors replay's useCursor.ts pattern using useSpot (not React Query).
 * All three hooks are parquet-only — SSE / stream modules are excluded per
 * ADR-0044. See useLiveCursor.invariant.test.ts for the static guard.
 *
 * Client-side bucket alignment: Math.floor(cursorMs / bucketMs) * bucketMs
 * is applied to both the URL `t=` param and the cache key to collapse
 * within-bucket motion to a single request.
 */
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import { useSpot } from './useSpot';
import { apiGet } from './client';
import { TIMEFRAME_TO_MS, type OrderbookResponse, type Timeframe } from './types';
import type { OrderbookSnapshot, BrokerSeriesEntry, SourceName } from './types';
import type { MinuteTimeframe } from '../state/livePage';
import { unixMsToKSTDate } from '../util/time';

// ─── Shared param type ────────────────────────────────────────────────────────

interface Params {
  code: string | null;
  timeframe: MinuteTimeframe | null;
}

// ─── Task 10 + T14b: useLiveOrderbookAtCursor ────────────────────────────────

/**
 * Full response shape returned by useLiveOrderbookAtCursor.
 * Includes available_from for the "다음 가용: HH:MM" hint (T14b, ADR-0044)
 * and source for the status chip.
 */
export interface LiveOrderbookSpot {
  snapshot: OrderbookSnapshot | null;
  available_from: number | null;
  source: SourceName;
}

/**
 * Live-side cursor-keyed orderbook spot, mirroring replay's
 * useOrderbookAtCursor. See ADR-0044 — parquet-only path, source_pref
 * threaded, client-side bucket alignment for cache stability.
 *
 * date is derived from cursorMs via unixMsToKSTDate, NOT passed as a prop —
 * this mirrors replay's useCursor pattern and fixes the regression where
 * hovering on past-date candles sent date=today to the API (ADR-0044).
 *
 * Returns undefined while loading / cursor absent, the full LiveOrderbookSpot
 * once fetched (snapshot may be null for pre-available slots).
 */
export function useLiveOrderbookAtCursor(p: Params): LiveOrderbookSpot | undefined {
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const bucketMs = p.timeframe ? TIMEFRAME_TO_MS[p.timeframe as Timeframe] : null;
  const alignedT =
    cursorMs !== null && bucketMs !== null
      ? Math.floor(cursorMs / bucketMs) * bucketMs
      : null;
  const date = cursorMs !== null ? unixMsToKSTDate(cursorMs) : null;

  const key =
    p.code && date && alignedT !== null && bucketMs !== null
      ? `live|ob|${p.code}|${date}|${alignedT}|${bucketMs}|${sourcePref}`
      : null;
  const { data } = useSpot<LiveOrderbookSpot>(key, () =>
    apiGet<OrderbookResponse>(
      `/api/orderbook?code=${p.code}&date=${date}&t=${alignedT}&bucket_ms=${bucketMs}&source_pref=${sourcePref}`,
    ).then((r) => ({
      snapshot: r.snapshot,
      available_from: r.available_from,
      source: r.source,
    })),
  );
  return data;
}

// ─── Task 12: useLiveBrokersAtCursor ─────────────────────────────────────────

interface BrokersParams {
  code: string | null;
  /** Minute timeframe, or null on D/W/M. Gates the fetch: /api/brokers/series
   *  is parquet-backed only on minute frames (ADR-0044). LiveChartRoot now
   *  publishes cursorMs on calendar frames too (for the Pane Legend), so
   *  without this gate a D/W/M hover would fire a spurious series fetch —
   *  mirrors useLiveOrderbookAtCursor's bucketMs gate. */
  timeframe: MinuteTimeframe | null;
}

/**
 * Live-side cursor-keyed broker day-series spot. Fetches the whole day series
 * once per (code, date, sourcePref); sidebar projects per-row net at cursorMs
 * client-side via BrokerTrajectoryTable's binary-search (same as replay).
 *
 * Key intentionally does NOT include cursorMs — the day series is cursor-
 * independent; moving the cursor within the same day must not refetch.
 * Key gates on cursorMs presence (null key = no fetch in latest mode).
 *
 * date is derived from cursorMs via unixMsToKSTDate, NOT passed as a prop —
 * fixes the regression where hovering past-date candles queried date=today.
 *
 * ADR-0039: source_pref threaded. ADR-0044: parquet path only.
 */
export function useLiveBrokersAtCursor(
  p: BrokersParams,
): BrokerSeriesEntry[] | undefined {
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const date = cursorMs !== null ? unixMsToKSTDate(cursorMs) : null;
  // Key gates on cursor presence AND a minute timeframe — no fetch in latest
  // mode, and never on D/W/M (no per-cursor parquet; LiveChartRoot publishes
  // cursorMs there only for the Pane Legend). The key omits cursorMs — the day
  // series is the same for any t within (code, date).
  const key =
    p.code && date && p.timeframe !== null
      ? `live|br|${p.code}|${date}|${sourcePref}`
      : null;
  const { data } = useSpot<BrokerSeriesEntry[]>(key, () =>
    apiGet<{ date: string; brokers: BrokerSeriesEntry[]; source: SourceName }>(
      `/api/brokers/series?code=${p.code}&date=${date}&source_pref=${sourcePref}`,
    ).then((r) => r.brokers),
  );
  return data;
}
