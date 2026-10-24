import type { LiveIndexCandlesResponse } from './liveIndices';

/** Query cache always holds the full window, even when the wire contains a tail.
 * null asks the caller for one bounded full refresh instead of guessing a prefix.
 */
export function restoreUsIndexDailyHistory(
  response: LiveIndexCandlesResponse,
  previous: LiveIndexCandlesResponse | undefined,
  requestedRevision: string | undefined,
): LiveIndexCandlesResponse | null {
  if (!response.daily_history_unchanged) return response;
  if (!previous || !requestedRevision || response.daily_history_revision !== requestedRevision
    || previous.daily_history_revision !== requestedRevision || response.timeframe !== 'D'
    || response.index_id !== previous.index_id || response.from !== previous.from || response.to !== previous.to
    || response.candles.length > 1) return null;
  const prefix = previous.candles.slice(0, -1);
  if (prefix.length && response.candles.length && prefix.at(-1)!.t_ms >= response.candles[0].t_ms) return null;
  return { ...response, daily_history_unchanged: false, candles: [...prefix, ...response.candles] };
}
