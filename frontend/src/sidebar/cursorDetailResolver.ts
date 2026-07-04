import type { BrokerSeriesEntry, OrderbookSnapshot } from '../api/types';
import { isMinuteTimeframe, type LiveTimeframe, type MinuteTimeframe } from '../state/livePage';

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

export function resolveOrderbookCardSnapshot({
  scope,
  spotSnapshot,
  inactiveSnapshot,
  bufferFallbackSnapshot,
}: {
  scope: CursorDetailScope;
  spotSnapshot: OrderbookSnapshot | null | undefined;
  inactiveSnapshot: OrderbookSnapshot | null;
  bufferFallbackSnapshot: OrderbookSnapshot | null;
}): OrderbookSnapshot | null | undefined {
  if (scope.kind === 'inactive') return inactiveSnapshot;
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
