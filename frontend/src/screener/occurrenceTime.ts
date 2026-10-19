import type { ScreenerOccurrence } from '../api/screener';

export function occurrenceTimeLabel(event: ScreenerOccurrence): string {
  if (event.bar_start_ms == null || !(event.bar_match ?? event.bar_price_match ?? event.bar_trade_value_match ?? event.bar_change_match)?.timeframe.endsWith('m')) return event.date;
  const clock = new Date(event.bar_start_ms + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
  return `${event.date} ${clock}`;
}
