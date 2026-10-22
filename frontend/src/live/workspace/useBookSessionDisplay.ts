import { useCallback, useMemo, useState } from 'react';
import type { OrderbookSnapshot } from '../../api/types';
import { afterHoursBookToSnapshot, afterHoursFillRows, useAfterHoursBook } from '../../api/liveAfterHoursBook';
import { hasBookPrices, preAuctionCutoff, useLivePreAuctionBook } from '../../api/livePreAuctionBook';
import type { LiveVenueOption } from '../../state/liveVenue';
import { useEffectiveVenue, useKrxAftermarketExcluded, useNxtEnabledResolver } from '../useEffectiveVenue';
import { bookSessionControl, bookSessionEpoch, hasBookSessionToggle, resolveBookSessionMode,
  type BookSessionMode, type BookSessionOverride } from '../bookSessionMode';
import { latestAfterHoursTotals } from '../liveSidebarAdapters';
import { liveVenueAcceptsFrame, type LiveFrameVenue } from '../liveVenuePolicy';
import { isKstWeekend, previousDayObExpired, realMsToYyyymmdd, regularSessionCloseMs } from '../liveDateTime';
import { isKrxAftermarketWindow, krxAftermarketIntroduced } from '../../util/stockSessions';
import { unixMsToKSTClock } from '../../util/time';
import { useAftermarketExclusion } from '../../api/aftermarketExclusion';

/** Shared session sources for the 10-level book and live order ladder. */
export function useBookSessionDisplay({ code, venue, nowMs, todayKst, isSpot, regularSnapshot,
  latestSnapshot, lastValidSnapshot, preAuctionSnapshot, afterHours }: {
  code: string; venue: LiveVenueOption; nowMs: number; todayKst: string; isSpot: boolean;
  regularSnapshot: OrderbookSnapshot | null | undefined;
  latestSnapshot: OrderbookSnapshot | null;
  lastValidSnapshot?: OrderbookSnapshot | null;
  preAuctionSnapshot?: OrderbookSnapshot | null;
  afterHours: ReadonlyArray<Record<string, unknown>>;
}) {
  const nxtEnabled = useNxtEnabledResolver()(code);
  const aftermarketExcluded = useKrxAftermarketExcluded(code);
  const effectiveVenue = useEffectiveVenue(code, venue);
  const date = realMsToYyyymmdd(nowMs);
  const retained = lastValidSnapshot && !previousDayObExpired(lastValidSnapshot.ts_ms, nowMs, effectiveVenue)
    ? lastValidSnapshot : null;
  const latestUsable = hasBookPrices(regularSnapshot) ? regularSnapshot : retained;
  const regularClose = regularSessionCloseMs(date);
  // The clock only selects a saved fallback. It never blocks an arriving book:
  // a usable 15:59:50 frame is immediately preferred to the pre-auction book.
  const useRegularFallback = !isSpot && effectiveVenue === 'KRX' && krxAftermarketIntroduced(date)
    && !isKstWeekend(date) && nowMs >= regularClose && (!latestUsable || (
      realMsToYyyymmdd(latestUsable.ts_ms) === date
      && latestUsable.ts_ms <= regularClose
    ));
  const preAuctionBook = useLivePreAuctionBook(code, date, useRegularFallback);
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
  const aftermarketExclusion = useAftermarketExclusion(code, effectiveVenue, nowMs,
    !isSpot && activeSinglePrice === null);
  const knownExcluded = aftermarketExcluded || (aftermarketExclusion?.reasons.length ?? 0) > 0;
  const singlePriceFills = useMemo(() => afterHoursFillRows(afterHoursBook.data), [afterHoursBook.data]);
  const selectedSnapshot = modeGated
    ? (sessionMode === 'afterHours' ? singlePriceSnapshot : regularSnapshot)
    : (singlePriceSnapshot ?? regularSnapshot);
  const preAuction = hasBookPrices(preAuctionSnapshot) ? preAuctionSnapshot : latestUsable;
  const savedRegular = hasBookPrices(preAuction) && preAuction.ts_ms < preAuctionCutoff(date)
    && realMsToYyyymmdd(preAuction.ts_ms) === date ? preAuction : null;
  const recoveredRegular = preAuctionBook.data;
  const frozenRegular = savedRegular && (!recoveredRegular || savedRegular.ts_ms > recoveredRegular.ts_ms)
    ? savedRegular : recoveredRegular ?? null;
  const snapshot = isSpot || modeGated || activeSinglePrice !== null ? selectedSnapshot
    : useRegularFallback ? frozenRegular : latestUsable;
  const earlyLive = !isSpot && activeSinglePrice === null && krxAftermarketIntroduced(date)
    && effectiveVenue === 'KRX' && snapshot != null
    && realMsToYyyymmdd(snapshot.ts_ms) === date
    && snapshot.ts_ms > regularClose && snapshot.ts_ms < regularClose + 30 * 60_000;
  // Closing residuals can arrive seconds after 15:30 and remain the last book.
  // Keep that ladder as a timestamped fallback once stale, while admitting a
  // fresh pre-reopening frame (e.g. 15:59:50) immediately as before.
  const storedLadder = !isSpot && !modeGated && activeSinglePrice === null
    && (useRegularFallback || (!hasBookPrices(regularSnapshot) && snapshot != null)
      || (earlyLive && nowMs - snapshot.ts_ms >= 30_000));
  const afterHoursSample = useMemo(() => {
    if (isSpot || activeSinglePrice !== null) return null;
    const latest = afterHours.at(-1);
    const receivedAtMs = latest?.t_ms;
    if (typeof receivedAtMs !== 'number' || !Number.isFinite(receivedAtMs) || receivedAtMs <= 0
      || realMsToYyyymmdd(receivedAtMs) !== date
      || !liveVenueAcceptsFrame(effectiveVenue, latest?.venue as LiveFrameVenue | undefined)) return null;
    if (snapshot != null && realMsToYyyymmdd(snapshot.ts_ms) !== todayKst) return null;
    // A 0D reset has no ladder. Compare 0E with the last usable ladder instead,
    // and keep its totals and timestamp together while the saved ladder stays put.
    const liveBook = hasBookPrices(latestSnapshot) ? latestSnapshot : latestUsable;
    const totals = latestAfterHoursTotals(afterHours, liveBook?.ts_ms ?? null);
    return totals === null ? null : { totals, receivedAtMs };
  }, [isSpot, activeSinglePrice, afterHours, date, effectiveVenue, snapshot, todayKst, latestSnapshot, latestUsable]);
  const afterHoursTotals = isSpot ? null : activeSinglePrice !== null
    ? { ask: activeSinglePrice.tot_ask, bid: activeSinglePrice.tot_bid }
    : afterHoursSample?.totals ?? null;
  const sessionControl = afterHoursSample !== null && !modeGated
    ? { kind: 'label' as const,
      label: `${afterHoursSample.receivedAtMs >= regularClose ? '시간외종가' : '시간외'} · ${unixMsToKSTClock(afterHoursSample.receivedAtMs)}` }
    : storedLadder && (snapshot != null || afterHoursTotals === null)
    ? { kind: 'label' as const, label: snapshot
      ? `${useRegularFallback ? '정규장 마지막' : '마지막 수신'} · ${unixMsToKSTClock(snapshot.ts_ms)}${useRegularFallback && isKrxAftermarketWindow(nowMs) && !knownExcluded ? ' · 수신 대기' : ''}`
      : '정규장 마지막 호가 없음' }
    : earlyLive ? { kind: 'label' as const,
      label: `${nowMs - snapshot.ts_ms < 30_000 ? '실시간 호가' : '마지막 수신'} · ${unixMsToKSTClock(snapshot.ts_ms)}` }
    : bookSessionControl({
    nowMs, ladderAtMs: snapshot?.ts_ms, aftermarketExcluded: knownExcluded, nxtEnabled, venue: effectiveVenue, isSpot,
    afterHoursStoredAtMs: afterHoursBook.data?.source === 'stored' ? afterHoursBook.data.fetched_at_ms : null,
    regularLadderAtMs: sessionMode === 'regular' && afterHoursTotals !== null && snapshot != null ? snapshot.ts_ms : null,
  });
  const timedSessionControl = sessionControl.kind === 'label' && snapshot && !sessionControl.label.includes(':')
    ? { ...sessionControl, label: `${sessionControl.label} · ${unixMsToKSTClock(snapshot.ts_ms)}` } : sessionControl;
  return { snapshot, storedLadder, activeSinglePrice, singlePriceFills, afterHoursBook, effectiveVenue, aftermarketExclusion,
    afterHoursTotals, afterHoursLabel: activeSinglePrice !== null ? '시간외 단일가' : '시간외',
    sessionControl: timedSessionControl, sessionMode, selectSessionMode };
}
