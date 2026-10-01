import { useMemo } from 'react';
import type { LiveSeriesData } from '../api/liveSeries';
import { createRegularSessionTradeFilter, filterRegularSessionSnapshots } from './regularSessionView';

/** Memoize each immutable stream separately: an OB flush or a parent viewport
 * render must not refilter trades and invalidate downstream incremental work. */
export function useRegularSessionLiveSeries(raw: LiveSeriesData, enabled: boolean): LiveSeriesData {
  const filterTrades = useMemo(createRegularSessionTradeFilter, []);
  const ob = useMemo(() => enabled ? filterRegularSessionSnapshots(raw.ob) : raw.ob, [raw.ob, enabled]);
  const trade = useMemo(() => enabled ? filterTrades(raw.trade) : raw.trade, [raw.trade, enabled, filterTrades]);
  const program = useMemo(() => enabled ? filterRegularSessionSnapshots(raw.program) : raw.program, [raw.program, enabled]);
  return useMemo(() => enabled ? { ...raw, ob, trade, program } : raw, [raw, enabled, ob, trade, program]);
}
