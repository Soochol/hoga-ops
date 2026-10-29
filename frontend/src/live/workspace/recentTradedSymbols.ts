import type { ExecutionHistoryRow } from '../../api/executionHistory';
import { unixMsToKSTDate } from '../../util/time';

export interface RecentTradedSymbol {
  code: string;
  name: string | null;
  filledAt: number | null;
}

/** The response is scoped to today's account. Never substitute order time for fill time. */
export function recentTradedSymbols(rows: readonly ExecutionHistoryRow[], date: string): RecentTradedSymbol[] {
  const symbols = new Map<string, RecentTradedSymbol>();
  for (const row of rows) {
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || !/^[A-Z0-9]{6}$/.test(row.code)) continue;
    const stamp = Date.parse(row.filled_at ?? '');
    const filledAt = Number.isFinite(stamp) ? stamp : null;
    if (filledAt !== null && unixMsToKSTDate(filledAt) !== date) continue;
    const previous = symbols.get(row.code);
    if (!previous) symbols.set(row.code, { code: row.code, name: row.name, filledAt });
    else {
      if ((filledAt ?? -Infinity) > (previous.filledAt ?? -Infinity)) {
        previous.filledAt = filledAt;
        previous.name = row.name || previous.name;
      } else previous.name ||= row.name;
    }
  }
  return [...symbols.values()].sort((a, b) =>
    (b.filledAt ?? -Infinity) - (a.filledAt ?? -Infinity) || a.code.localeCompare(b.code));
}
