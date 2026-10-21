import { useMemo, useState } from 'react';
import { useTradeHistory } from '../../api/tradeHistory';
import type { TradeSnapshot } from '../bucketHogaSeries';
import { realMsToYyyymmdd } from '../liveDateTime';
import { buildTradeTickView, combineTradeHistory, mergeTradeTicks, type TradeTick } from '../tradeTicks';

const LIMIT = 9;

/** Share the tape's initial history query, but never page or poll for a book.
 * Both the live tail and retained ticks stay bounded to the nine visible rows. */
export function useRecentBookTrades({ code, date, venue, frames, enabled }: {
  code: string; date: string; venue: string; frames: readonly TradeSnapshot[]; enabled: boolean;
}) {
  const history = useTradeHistory(code, date, venue, enabled);
  const scope = `${code}:${date}:${venue}`;
  const live = useMemo(() => buildTradeTickView(frames, LIMIT).ticks
    .filter(tick => realMsToYyyymmdd(tick.tMs) === date), [frames, date]);
  const [remembered, setRemembered] = useState<{ scope: string; ticks: TradeTick[] }>({ scope, ticks: [] });
  const observed = useMemo(() => mergeTradeTicks(live, remembered.scope === scope ? remembered.ticks : [])
    .slice(0, LIMIT), [live, remembered, scope]);
  if (remembered.scope !== scope || observed.length !== remembered.ticks.length
    || observed.some((tick, i) => tick.key !== remembered.ticks[i].key
      || tick.price !== remembered.ticks[i].price || tick.qty !== remembered.ticks[i].qty
      || tick.side !== remembered.ticks[i].side)) setRemembered({ scope, ticks: observed });

  const first = history.data?.pages[0];
  return useMemo(() => {
    if (!enabled) return [];
    // Query keys isolate these already; also reject mismatched response metadata.
    if (!first || first.code !== code || first.date !== date || first.venue !== venue) return observed;
    const past = first.rows.slice(0, LIMIT).map(row => ({ key: row.event_id, tMs: row.t_ms,
      price: row.price, qty: row.qty, side: row.side, cumVolume: row.cum_volume }));
    return combineTradeHistory(observed, past, first.latest_at_ms, first.latest_volume).slice(0, LIMIT);
  }, [enabled, first, code, date, venue, observed]);
}
