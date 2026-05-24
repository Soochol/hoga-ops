import { useMemo } from 'react';
import type { StockDate } from '../api/types';
import type { StockDateGroup } from './types';

export function useStockDateGroups(rows: StockDate[], search: string): StockDateGroup[] {
  return useMemo(() => {
    const map = new Map<string, StockDate[]>();
    for (const r of rows) {
      const arr = map.get(r.code);
      if (arr) arr.push(r);
      else map.set(r.code, [r]);
    }

    const groups: StockDateGroup[] = [];
    for (const [code, dates] of map) {
      dates.sort((a, b) => b.date.localeCompare(a.date));
      const lastCapturedAt = dates.reduce((m, d) => Math.max(m, d.captured_at), 0);
      const totalSizeBytes = dates.reduce((s, d) => s + d.file_size_bytes, 0);
      groups.push({
        code,
        name: dates[0].name,
        dates,
        lastCapturedAt,
        totalSizeBytes,
      });
    }
    groups.sort((a, b) => b.lastCapturedAt - a.lastCapturedAt);

    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(g => g.name.toLowerCase().includes(q) || g.code.includes(q));
  }, [rows, search]);
}
