import { useCallback, useMemo, useState } from 'react';
import type { OrderbookSnapshot } from '../../api/types';
import { afterHoursBookToSnapshot, afterHoursFillRows, useAfterHoursBook } from '../../api/liveAfterHoursBook';
import type { LiveVenueOption } from '../../state/liveVenue';
import { useEffectiveVenue, useKrxAftermarketExcluded, useNxtEnabledResolver } from '../useEffectiveVenue';
import { bookSessionControl, bookSessionEpoch, hasBookSessionToggle, resolveBookSessionMode,
  type BookSessionMode, type BookSessionOverride } from '../bookSessionMode';
import { latestAfterHoursTotals } from '../liveSidebarAdapters';
import { realMsToYyyymmdd } from '../liveDateTime';

/** Shared session sources for the 10-level book and live order ladder. */
export function useBookSessionDisplay({ code, venue, nowMs, todayKst, isSpot, regularSnapshot,
  latestSnapshot, afterHours }: {
  code: string; venue: LiveVenueOption; nowMs: number; todayKst: string; isSpot: boolean;
  regularSnapshot: OrderbookSnapshot | null | undefined;
  latestSnapshot: OrderbookSnapshot | null;
  afterHours: ReadonlyArray<Record<string, unknown>>;
}) {
  const nxtEnabled = useNxtEnabledResolver()(code);
  const aftermarketExcluded = useKrxAftermarketExcluded(code);
  const effectiveVenue = useEffectiveVenue(code, venue);
  const [sessionOverride, setSessionOverride] = useState<BookSessionOverride>(null);
  const sessionMode = resolveBookSessionMode(sessionOverride, nowMs);
  const selectSessionMode = useCallback((mode: BookSessionMode) => {
    setSessionOverride({ mode, epoch: bookSessionEpoch() });
  }, []);
  const modeGated = hasBookSessionToggle(nxtEnabled, isSpot, nowMs);
  const showAfterHours = !modeGated || sessionMode === 'afterHours';
  const afterHoursBook = useAfterHoursBook(isSpot ? null : code, {
    includeStored: modeGated && sessionMode === 'afterHours',
  });
  const singlePriceSnapshot = useMemo(() => afterHoursBookToSnapshot(afterHoursBook.data), [afterHoursBook.data]);
  const activeSinglePrice = showAfterHours ? singlePriceSnapshot : null;
  const singlePriceFills = useMemo(() => afterHoursFillRows(afterHoursBook.data), [afterHoursBook.data]);
  const snapshot = modeGated
    ? (sessionMode === 'afterHours' ? singlePriceSnapshot : regularSnapshot)
    : (singlePriceSnapshot ?? regularSnapshot);
  const afterHoursTotals = useMemo(() => {
    if (isSpot) return null;
    if (activeSinglePrice !== null) return { ask: activeSinglePrice.tot_ask, bid: activeSinglePrice.tot_bid };
    const totals = latestAfterHoursTotals(afterHours, latestSnapshot?.ts_ms ?? null);
    if (totals === null || showAfterHours || snapshot == null) return totals;
    // A frozen regular ladder must not receive another day's after-hours totals.
    return realMsToYyyymmdd(snapshot.ts_ms) === todayKst ? totals : null;
  }, [isSpot, activeSinglePrice, afterHours, latestSnapshot, showAfterHours, snapshot, todayKst]);
  const sessionControl = bookSessionControl({
    nowMs, ladderAtMs: snapshot?.ts_ms, aftermarketExcluded, nxtEnabled, venue: effectiveVenue, isSpot,
    afterHoursStoredAtMs: afterHoursBook.data?.source === 'stored' ? afterHoursBook.data.fetched_at_ms : null,
    regularLadderAtMs: sessionMode === 'regular' && afterHoursTotals !== null && snapshot != null ? snapshot.ts_ms : null,
  });
  return { snapshot, activeSinglePrice, singlePriceFills, afterHoursBook, effectiveVenue,
    afterHoursTotals, afterHoursLabel: activeSinglePrice !== null ? '시간외 단일가' : '시간외',
    sessionControl, sessionMode, selectSessionMode };
}
