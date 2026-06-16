import type { LiveQuote } from '../api/liveQuotes';
import type { WatchlistEntry } from '../api/watchlist';

export type QuoteSortMode = 'default' | 'change_pct_asc' | 'change_pct_desc';

export function makeChangePctOf(quoteByCode: Map<string, LiveQuote>): (code: string) => number | null {
  return (code) => {
    const pct = quoteByCode.get(code)?.change_pct;
    return typeof pct === 'number' && Number.isFinite(pct) ? pct : null;
  };
}

export function sortEntriesByChangePct(
  entries: WatchlistEntry[],
  pctOf: (code: string) => number | null,
  mode: QuoteSortMode,
): WatchlistEntry[] {
  if (mode === 'default') return [...entries].sort((a, b) => a.order - b.order);

  const dir = mode === 'change_pct_asc' ? 1 : -1;
  return entries
    .map((entry) => ({ entry, pct: pctOf(entry.code) }))
    .sort((a, b) => {
      if (a.pct == null && b.pct == null) return a.entry.order - b.entry.order;
      if (a.pct == null) return 1;
      if (b.pct == null) return -1;
      const byPct = (a.pct - b.pct) * dir;
      return byPct === 0 ? a.entry.order - b.entry.order : byPct;
    })
    .map((x) => x.entry);
}
