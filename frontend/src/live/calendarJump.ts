import type { LivePastDailyCandlesResponse } from '../api/livePastDailyCandles';
import type { ScreenerDailyCandlesResponse } from '../api/screenerDailyCandles';
import { isWarningFailure } from '../api/dataWarnings';
import type { CalendarJumpSource } from '../chart/timeframeJump';
import type { CalendarTimeframe } from '../state/livePage';
import type { LiveVenueOption } from '../state/liveVenue';
import { calendarBucketKey } from './aggregateCandles';
import { realMsToYyyymmdd } from './liveDateTime';
import type { JumpRange } from './minuteJumpDestination';

export type CalendarQueryIdentity = {
  code: string;
  from: string;
  to: string;
  venue: LiveVenueOption;
  source: 'vendor' | 'disk';
  timeframe: CalendarTimeframe;
};
export type CalendarQueryStatus =
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'ready'; from: string; to: string };

type CalendarResponse = LivePastDailyCandlesResponse | ScreenerDailyCandlesResponse;

/** An echoed range is authoritative only for the current, complete query. */
export function calendarQueryStatus(args: {
  identity: CalendarQueryIdentity;
  data: CalendarResponse | undefined;
  isPlaceholderData: boolean;
  isPending: boolean;
  error: unknown;
}): CalendarQueryStatus {
  const { identity: q, data, isPlaceholderData, isPending, error } = args;
  if (error) return { kind: 'failed' };
  if (isPlaceholderData || isPending || !data) return { kind: 'pending' };
  const sourceMatches = q.source === 'disk'
    ? 'source' in data && data.source === 'screener_daily'
    : !('source' in data) && (data.venue ?? 'KRX') === q.venue
      && ('timeframe' in data ? data.timeframe : 'D') === q.timeframe;
  if (!sourceMatches || data.code !== q.code || data.from !== q.from || data.to !== q.to
    || data.data_warnings.some(isWarningFailure)) return { kind: 'failed' };
  return { kind: 'ready', from: data.from, to: data.to };
}

export function calendarPeriodStart(dateMs: number, timeframe: CalendarTimeframe): string {
  const date = new Date(dateMs + 9 * 3_600_000);
  if (timeframe === 'M') date.setUTCDate(1);
  if (timeframe === 'W') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

export function calendarJumpSource(args: {
  range: JumpRange;
  timeframe: CalendarTimeframe;
  code: string;
  venue: LiveVenueOption;
  source: 'vendor' | 'disk';
  sourceKey: string;
  cutoffDate: string;
}): CalendarJumpSource {
  const { range, timeframe, code, venue, source, sourceKey, cutoffDate } = args;
  const cutoffEnd = Date.UTC(Number(cutoffDate.slice(0, 4)), Number(cutoffDate.slice(4, 6)) - 1,
    Number(cutoffDate.slice(6, 8)) + 1) - 9 * 3_600_000 - 1;
  const cutoffMs = Math.min(range.toMs, cutoffEnd);
  return { code, venue, source, sourceKey, from: calendarPeriodStart(range.fromMs, timeframe),
    to: realMsToYyyymmdd(cutoffMs), cutoffMs };
}

export function lastObservedDailyDate(
  source: CalendarJumpSource,
  candles: readonly { t_ms: number }[],
): string | null {
  let last: string | null = null;
  for (const candle of candles) {
    if (!Number.isFinite(candle.t_ms)) continue;
    const date = realMsToYyyymmdd(candle.t_ms);
    if (date >= source.from && date <= source.to && (last === null || date > last)) last = date;
  }
  return last;
}

export function exactCalendarTarget(
  candles: readonly { ts_ms: number }[], date: string, timeframe: CalendarTimeframe,
): number | null {
  const dayMs = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)));
  const key = calendarBucketKey(dayMs, timeframe);
  return candles.find(candle => calendarBucketKey(candle.ts_ms, timeframe) === key)?.ts_ms ?? null;
}
