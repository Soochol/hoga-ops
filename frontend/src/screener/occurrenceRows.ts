import type { ScreenerRow, ScreenerOccurrence } from '../api/screener';

export type OccurrenceRow<T> = T & { resultKey: string; occurrence?: ScreenerOccurrence; occurrence_date?: string };

export function occurrenceKey(code: string, event: ScreenerOccurrence): string {
  return JSON.stringify([code, event.condition_id, event.condition_key, event.date]);
}

/** Preserve legacy rows without inventing an occurrence date. */
export function occurrenceRows<T extends Pick<ScreenerRow, 'code' | 'occurrences' | 'history_matches'>>(rows: readonly T[]): OccurrenceRow<T>[] {
  return rows.flatMap(row => row.occurrences?.length
    ? row.occurrences.map(event => ({ ...row, resultKey: occurrenceKey(row.code, event),
      occurrence: event, occurrence_date: event.date, occurrences: [event],
      history_matches: event.history_match ? [event.history_match]
        : row.history_matches?.filter(m => m.condition_id === event.condition_id && m.date === event.date) }))
    : [{ ...row, resultKey: row.code }]);
}

export function resultKey(row: { code: string; resultKey?: string }): string {
  return row.resultKey ?? row.code;
}
