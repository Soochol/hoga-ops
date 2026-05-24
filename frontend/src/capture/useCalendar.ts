import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCalendar } from '../api/calendar';
import type { CalendarCell, CalendarResponse, UpstreamCode } from '../api/types';

/** Calendar cell extended with a client-only `patched_at_ms` annotation
 *  stamped by SSE handlers. The backend wire shape (CalendarCell in types.ts)
 *  does NOT carry this field — it's only meaningful in the React Query cache. */
export interface EnrichedCell extends CalendarCell {
  patched_at_ms?: number;
}

export interface EnrichedCalendarResponse {
  cells: EnrichedCell[];
  as_of_ms: number;
  reason?: UpstreamCode | null;
}

export const CALENDAR_QUERY_KEY = (code: string, year: number, month: number) =>
  ['calendar', code, year, month] as const;

/** Merge an incoming GET response against a possibly-existing cache.
 *  Q21: a prior cell with `patched_at_ms > incoming.as_of_ms` is preserved
 *  (the SSE patch is fresher than what GET could have seen). */
export function reconcileCalendar(
  prior: EnrichedCalendarResponse | undefined,
  incoming: CalendarResponse,
): EnrichedCalendarResponse {
  if (prior === undefined) {
    return { cells: incoming.cells.map((c) => ({ ...c })), as_of_ms: incoming.as_of_ms, reason: incoming.reason };
  }
  const priorByDate = new Map(prior.cells.map((c) => [c.date, c]));
  const cells: EnrichedCell[] = incoming.cells.map((c) => {
    const prev = priorByDate.get(c.date);
    if (prev?.patched_at_ms !== undefined && prev.patched_at_ms > incoming.as_of_ms) {
      return prev;
    }
    return { ...c };
  });
  return { cells, as_of_ms: incoming.as_of_ms, reason: incoming.reason };
}

/** Stamp a per-cell SSE patch with `patched_at_ms = now`. Used by useCaptureQueue
 *  when a capture_finished event arrives for (code, date). */
export function applyCellPatch(
  prior: EnrichedCalendarResponse,
  date: string,
  patch: Partial<Pick<EnrichedCell, 'status' | 'captured_at_ms'>>,
  now: number,
): EnrichedCalendarResponse {
  const idx = prior.cells.findIndex((c) => c.date === date);
  if (idx === -1) return prior;
  const cells = prior.cells.slice();
  cells[idx] = { ...cells[idx], ...patch, patched_at_ms: now };
  return { ...prior, cells };
}

export function useCalendar(code: string | null, year: number, month: number) {
  const qc = useQueryClient();
  const queryKey = CALENDAR_QUERY_KEY(code ?? '', year, month);
  return useQuery<EnrichedCalendarResponse>({
    queryKey,
    queryFn: async () => {
      // F2 (eng review): Q21 reconciliation MUST run when the GET response
      // lands in the cache, not in `select` (which only sees raw queryFn data,
      // never the prior cache — `select` re-runs on every render against the
      // same raw input). Pull the prior EnrichedCalendarResponse via
      // getQueryData, reconcile with the incoming wire CalendarResponse, and
      // store the merged result. Subsequent SSE patches via applyCellPatch
      // operate on the enriched shape uniformly.
      const incoming = await getCalendar(code as string, year, month);
      const prev = qc.getQueryData<EnrichedCalendarResponse>(queryKey);
      return reconcileCalendar(prev, incoming);
    },
    enabled: code !== null,
    staleTime: 60_000,
  });
}

/** Status → calendar marker glyph convention (used by tests + CalendarCell).
 *  Implementation lives in calendarStatus.ts as part of the single
 *  CalendarStatusDescriptor table; re-exported here for backward
 *  compatibility with existing import sites. */
export { markerFor } from './calendarStatus';
