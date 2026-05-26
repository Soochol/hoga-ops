import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StockDate } from '../api/types';
import { isRecapturable } from './DiskStateBadge';

/** Concentrates the Inventory re-capture selection lifecycle behind one
 *  interface: which dates are eligible, which the user has picked, and the
 *  reset/prune rules that keep the picked set coherent with the rendered
 *  rows. Pulled out of StockDateGroupDetail so the selection invariants
 *  (reset on Code change, prune when a row flips to complete or is removed)
 *  are testable without mounting the table.
 *
 *  `selectedCode` is the discriminator the caller uses to scope the
 *  selection to one StockDateGroup. The hook does not look up the group
 *  itself — callers pre-filter `rows` to the current group. */
export function useRecaptureSelection(rows: readonly StockDate[], selectedCode: string | null) {
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());

  // Reset when the active Code changes — selection is scoped to one group.
  useEffect(() => { setSelectedDates(new Set()); }, [selectedCode]);

  const recapturableDates = useMemo(
    () => new Set(rows.filter(r => isRecapturable(r.disk_state)).map(r => r.date)),
    [rows],
  );

  // Prune entries no longer in recapturableDates (row removed or flipped to complete).
  useEffect(() => {
    setSelectedDates(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const d of prev) {
        if (recapturableDates.has(d)) next.add(d);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [recapturableDates]);

  const toggleSelection = useCallback((date: string) => {
    setSelectedDates(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedDates(new Set()), []);

  return { selectedDates, recapturableDates, toggleSelection, clearSelection };
}
