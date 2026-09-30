import { unixMsToKSTDate } from '../util/time';
import type { BrokerSeriesEntry, OrderbookSnapshot } from '../api/types';
import { isMinuteTimeframe, isSecondTimeframe, type SecondTimeframe, type LiveTimeframe, type MinuteTimeframe } from '../state/livePage';

export type CursorDetailScope =
  | { kind: 'inactive'; cursorMs: null; minuteTimeframe: null }
  | { kind: 'minute-cursor'; cursorMs: number; minuteTimeframe: MinuteTimeframe };

export function resolveCursorDetailScope({
  cursorMs,
  timeframe,
}: {
  cursorMs: number | null;
  timeframe: LiveTimeframe | null;
}): CursorDetailScope {
  if (cursorMs !== null && timeframe !== null && isMinuteTimeframe(timeframe)) {
    return { kind: 'minute-cursor', cursorMs, minuteTimeframe: timeframe };
  }
  return { kind: 'inactive', cursorMs: null, minuteTimeframe: null };
}

export type OrderbookCursorScope = CursorDetailScope
  | { kind: 'second-cursor'; cursorMs: number; minuteTimeframe: null; secondTimeframe: SecondTimeframe };

/** Only orderbooks opt into seconds; other detail cards keep their minute contract. */
export function resolveOrderbookCursorScope(params: {
  cursorMs: number | null;
  timeframe: LiveTimeframe | null;
}): OrderbookCursorScope {
  if (params.cursorMs !== null && params.timeframe !== null && isSecondTimeframe(params.timeframe)) {
    return { kind: 'second-cursor', cursorMs: params.cursorMs, minuteTimeframe: null, secondTimeframe: params.timeframe };
  }
  return resolveCursorDetailScope(params);
}

export function resolveOrderbookCardSnapshot({
  scope,
  spotSnapshot,
  inactiveSnapshot,
  bufferFallbackSnapshot,
}: {
  scope: OrderbookCursorScope;
  spotSnapshot: OrderbookSnapshot | null | undefined;
  inactiveSnapshot: OrderbookSnapshot | null;
  bufferFallbackSnapshot: OrderbookSnapshot | null;
}): OrderbookSnapshot | null | undefined {
  if (scope.kind === 'inactive') return inactiveSnapshot;
  if (scope.kind === 'second-cursor') {
    // A response retained from a later cursor must never leak a future book.
    const candidates = [spotSnapshot, bufferFallbackSnapshot].filter(
      (s): s is OrderbookSnapshot => s != null && s.ts_ms <= scope.cursorMs
        && unixMsToKSTDate(s.ts_ms) === unixMsToKSTDate(scope.cursorMs),
    );
    return candidates.sort((a, b) => b.ts_ms - a.ts_ms)[0]
      ?? (spotSnapshot === undefined ? undefined : null);
  }
  if (spotSnapshot === undefined) return undefined;
  return spotSnapshot ?? bufferFallbackSnapshot;
}

export function resolveBrokerCardProps({
  scope,
  spotSeries,
  inactiveSeries,
  inactiveCursorMs,
}: {
  scope: CursorDetailScope;
  spotSeries: BrokerSeriesEntry[] | null | undefined;
  inactiveSeries: BrokerSeriesEntry[] | null | undefined;
  inactiveCursorMs: number | null;
}): { series: BrokerSeriesEntry[] | null | undefined; cursorMs: number | null } {
  if (scope.kind === 'minute-cursor') {
    return { series: spotSeries, cursorMs: scope.cursorMs };
  }
  return { series: inactiveSeries, cursorMs: inactiveCursorMs };
}
