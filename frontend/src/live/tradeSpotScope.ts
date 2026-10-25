import { TIMEFRAME_TO_MS } from '../api/types';
import { isMinuteTimeframe, isSecondTimeframe, needsRegularSessionClip } from '../state/livePage';
import type { LiveVenueOption } from '../state/liveVenue';
import { realMsToYyyymmdd, regularSessionCloseMs } from './liveDateTime';
import type { SidebarCursorOrigin } from './useLiveCursorStore';
import { minuteBucketStartMs } from './aggregateCandles';

export function tradeSpotScope(cursorMs: number | null, origin: SidebarCursorOrigin | null,
  code: string, group: number | undefined, fallbackVenue: LiveVenueOption) {
  if (cursorMs === null || origin === null || group === undefined || origin.group !== group || origin.code !== code) return null;
  const tf = origin.timeframe;
  const bucketMs = isSecondTimeframe(tf) ? Number(tf.slice(0, -1)) * 1000 : isMinuteTimeframe(tf) ? TIMEFRAME_TO_MS[tf] : null;
  if (bucketMs === null) return null;
  const fromMs = origin.barStartMs ?? cursorMs;
  const date = realMsToYyyymmdd(fromMs);
  const midnight = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00+09:00`);
  const toMs = Math.min(fromMs + bucketMs, midnight + 86_400_000,
    needsRegularSessionClip(tf) || origin.regularSessionOnly ? regularSessionCloseMs(date) + 1000 : Infinity);
  if (toMs <= fromMs) return null;
  return { date, fromMs, toMs, timeframe: tf, venue: origin.venue ?? fallbackVenue,
    regularSessionOnly: origin.regularSessionOnly ?? false };
}

export type TradeSpotScope = NonNullable<ReturnType<typeof tradeSpotScope>>;

export function earlierTradeScope(scope: TradeSpotScope, observedMs: number | null | undefined): TradeSpotScope | null {
  if (observedMs == null || observedMs >= scope.fromMs || realMsToYyyymmdd(observedMs) !== scope.date) return null;
  const tf = scope.timeframe;
  const bucketMs = isSecondTimeframe(tf) ? Number(tf.slice(0, -1)) * 1000 : isMinuteTimeframe(tf) ? TIMEFRAME_TO_MS[tf] : 0;
  if (!bucketMs) return null;
  const fromMs = minuteBucketStartMs(observedMs, bucketMs, scope.venue);
  if (fromMs >= scope.fromMs) return null;
  const open = Date.parse(`${scope.date.slice(0, 4)}-${scope.date.slice(4, 6)}-${scope.date.slice(6)}T09:00:00+09:00`);
  if ((scope.regularSessionOnly || needsRegularSessionClip(tf)) && observedMs < open) return null;
  return tradeSpotScope(fromMs, { windowId: null, group: 1, code: '', timeframe: tf,
    venue: scope.venue, regularSessionOnly: scope.regularSessionOnly, barStartMs: fromMs }, '', 1, scope.venue);
}
