import { useCallback, useMemo, useState } from 'react';
import type { OrderbookSnapshot } from '../../api/types';
import { afterHoursBookToSnapshot, afterHoursFillRows, isAfterHoursSinglePriceWindow, useAfterHoursBook } from '../../api/liveAfterHoursBook';
import type { BookQueryObservation } from '../bookAvailabilitySources';
import { hasBookPrices, preAuctionCutoff, useLivePreAuctionBook } from '../../api/livePreAuctionBook';
import type { LiveVenueOption } from '../../state/liveVenue';
import { useEffectiveVenue, useKrxAftermarketExcluded, useNxtEnabledResolver } from '../useEffectiveVenue';
import { bookSessionControl, bookSessionEpoch, hasBookSessionToggle, resolveBookSessionMode,
  type BookSessionMode, type BookSessionOverride } from '../bookSessionMode';
import { latestAfterHoursTotals } from '../liveSidebarAdapters';
import { liveVenueAcceptsFrame, type LiveFrameVenue } from '../liveVenuePolicy';
import { isKstWeekend, previousDayObExpired, realMsToYyyymmdd, regularSessionCloseMs } from '../liveDateTime';
import { isKrxAftermarketWindow, krxAftermarketIntroduced } from '../../util/stockSessions';
import { unixMsToKSTClock, unixMsToKSTHhmm } from '../../util/time';
import { useAftermarketExclusion } from '../../api/aftermarketExclusion';
import { recentBookEvidence } from '../orderbookAvailability';

export type BookLadderSource = 'live' | 'retained' | 'saved' | 'cursor' | 'singlePrice' | 'none';

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
  const latestAfterHours = afterHours.at(-1);
  const afterHoursAtMs = latestAfterHours?.t_ms;
  const currentAfterHours = typeof afterHoursAtMs === 'number' && Number.isFinite(afterHoursAtMs)
    && afterHoursAtMs > 0 && realMsToYyyymmdd(afterHoursAtMs) === date
    && liveVenueAcceptsFrame(effectiveVenue, latestAfterHours?.venue as LiveFrameVenue | undefined);
  // A new day's 0E may arrive before 08:30. It replaces yesterday's ladder
  // immediately; the wall clock is only the latest time to clear that ladder.
  const expired = (book: OrderbookSnapshot) => previousDayObExpired(book.ts_ms, nowMs, effectiveVenue)
    || (currentAfterHours && realMsToYyyymmdd(book.ts_ms) !== date);
  const regular = !isSpot && regularSnapshot && expired(regularSnapshot) ? null : regularSnapshot;
  const retained = lastValidSnapshot && !expired(lastValidSnapshot)
    ? lastValidSnapshot : null;
  const latestUsable = hasBookPrices(regular) && (!retained || regular.ts_ms >= retained.ts_ms)
    ? regular : retained;
  const morningReset = previousDayObExpired(nowMs - 86_400_000, nowMs, effectiveVenue);
  const regularClose = regularSessionCloseMs(date);
  // A clock boundary never replaces a received ladder, including an auction
  // still publishing after 15:30. Disk recovery only fills a missing ladder.
  const useRegularFallback = !isSpot && effectiveVenue === 'KRX' && krxAftermarketIntroduced(date)
    && !isKstWeekend(date) && nowMs >= regularClose && !latestUsable;
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
  const preAuction = hasBookPrices(preAuctionSnapshot) ? preAuctionSnapshot : latestUsable;
  const savedRegular = hasBookPrices(preAuction) && preAuction.ts_ms < preAuctionCutoff(date)
    && realMsToYyyymmdd(preAuction.ts_ms) === date ? preAuction : null;
  const recoveredRegular = preAuctionBook.data;
  const frozenRegular = savedRegular && (!recoveredRegular || savedRegular.ts_ms > recoveredRegular.ts_ms)
    ? savedRegular : recoveredRegular ?? null;
  const snapshot = isSpot ? regular
    : modeGated && sessionMode === 'afterHours' ? singlePriceSnapshot
    : activeSinglePrice ?? latestUsable ?? (useRegularFallback ? frozenRegular : null);
  const ladderSource: BookLadderSource = snapshot == null ? 'none'
    : isSpot ? 'cursor' : activeSinglePrice !== null ? 'singlePrice'
    : snapshot === latestUsable ? (snapshot === regular ? 'live' : 'retained') : 'saved';
  // Receipt/REST activity never makes a retained or saved ladder orderable.
  const bookFresh = ladderSource === 'live' && recentBookEvidence(snapshot?.ts_ms, nowMs);
  const closingLadder = !isSpot && activeSinglePrice === null && krxAftermarketIntroduced(date)
    && effectiveVenue === 'KRX' && snapshot != null
    && realMsToYyyymmdd(snapshot.ts_ms) === date
    && nowMs >= regularClose && snapshot.ts_ms >= preAuctionCutoff(date)
    && snapshot.ts_ms < regularClose + 30 * 60_000;
  const lastReceived = ladderSource === 'retained' || (closingLadder && !bookFresh);
  // Quiet closing books have their footer timestamp. Active-market stale books
  // still use the existing connection/recovery diagnostics.
  const monitorBook = !isSpot && activeSinglePrice === null && ladderSource !== 'saved'
    && !(closingLadder && !bookFresh);
  const afterHoursSample = useMemo(() => {
    if (isSpot || activeSinglePrice !== null) return null;
    if (!currentAfterHours || typeof afterHoursAtMs !== 'number') return null;
    if (snapshot != null && realMsToYyyymmdd(snapshot.ts_ms) !== todayKst) return null;
    // A 0D reset has no ladder. Compare 0E with the last usable ladder instead,
    // and keep its totals and timestamp together while the saved ladder stays put.
    const liveBook = hasBookPrices(latestSnapshot) && realMsToYyyymmdd(latestSnapshot.ts_ms) === date
      ? latestSnapshot : latestUsable;
    const totals = latestAfterHoursTotals(afterHours, liveBook?.ts_ms ?? null);
    return totals === null ? null : { totals, receivedAtMs: afterHoursAtMs };
  }, [isSpot, activeSinglePrice, afterHours, date, currentAfterHours, afterHoursAtMs, snapshot, todayKst, latestSnapshot, latestUsable]);
  const afterHoursTotals = isSpot ? null : activeSinglePrice !== null
    ? { ask: activeSinglePrice.tot_ask, bid: activeSinglePrice.tot_bid }
    : afterHoursSample?.totals ?? null;
  const sessionControl = afterHoursSample !== null && !modeGated
    ? { kind: 'label' as const,
      label: `${afterHoursSample.receivedAtMs >= regularClose ? '시간외종가' : '시간외'} · ${unixMsToKSTClock(afterHoursSample.receivedAtMs)}` }
    : (ladderSource === 'saved' || lastReceived || useRegularFallback) && (snapshot != null || afterHoursTotals === null)
    ? { kind: 'label' as const, label: snapshot
      ? `${useRegularFallback ? '정규장 마지막' : '마지막 수신'} · ${unixMsToKSTClock(snapshot.ts_ms)}${useRegularFallback && isKrxAftermarketWindow(nowMs) && !knownExcluded ? ' · 수신 대기' : ''}`
      : '정규장 마지막 호가 없음' }
    : closingLadder ? { kind: 'label' as const,
      label: `실시간 호가 · ${unixMsToKSTClock(snapshot.ts_ms)}` }
    : bookSessionControl({
    nowMs, ladderAtMs: snapshot?.ts_ms, aftermarketExcluded: knownExcluded, nxtEnabled, venue: effectiveVenue, isSpot,
    afterHoursStoredAtMs: afterHoursBook.data?.source === 'stored' ? afterHoursBook.data.fetched_at_ms : null,
    regularLadderAtMs: sessionMode === 'regular' && afterHoursTotals !== null && snapshot != null ? snapshot.ts_ms : null,
  });
  const timedSessionControl = sessionControl.kind === 'label' && snapshot && !sessionControl.label.includes(':')
    ? { ...sessionControl, label: `${sessionControl.label} · ${unixMsToKSTClock(snapshot.ts_ms)}` } : sessionControl;
  // ka10004 has no trading date. Once the KRX day starts, it cannot prove
  // that a cached/just-fetched ladder belongs to today. Wait for dated data.
  const allowRestBook = afterHoursTotals === null && (effectiveVenue !== 'KRX'
    || !morningReset || unixMsToKSTHhmm(nowMs) >= 2000);
  const selectedSinglePrice = !isSpot && !krxAftermarketIntroduced(date)
    && (isAfterHoursSinglePriceWindow(nowMs) || (modeGated && sessionMode === 'afterHours')) && showAfterHours;
  const bookQuery: BookQueryObservation | undefined = selectedSinglePrice
    ? { target: 'single_price', loading: afterHoursBook.isLoading, error: afterHoursBook.isError,
      retry: () => afterHoursBook.refetch({ cancelRefetch: false }) }
    : useRegularFallback ? { target: 'saved_regular', loading: preAuctionBook.isLoading, error: preAuctionBook.isError,
      retry: () => preAuctionBook.refetch({ cancelRefetch: false }) } : undefined;
  return { snapshot, ladderSource, bookFresh, monitorBook, activeSinglePrice, singlePriceFills, afterHoursBook, effectiveVenue, aftermarketExclusion,
    allowRestBook, morningReset, afterHoursTotals, bookQuery, afterHoursLabel: activeSinglePrice !== null ? '시간외 단일가' : '시간외',
    sessionControl: timedSessionControl, sessionMode, selectSessionMode };
}
