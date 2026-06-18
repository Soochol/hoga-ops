import { TIMEFRAME_TO_MS } from '../api/types';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import { LIVE_VENUE_LABELS, type LiveVenueOption } from '../state/liveVenue';
import {
  isKrxRegularSessionNow,
  realMsToYyyymmdd,
  regularSessionCloseMs,
  regularSessionOpenMs,
} from './liveDateTime';

const EXTENDED_SESSION_MINUTES = 12 * 60;

export function liveVenueDisplayLabel(venue: LiveVenueOption): string {
  return LIVE_VENUE_LABELS[venue];
}

export function liveVenueKeepsHogaKrx(venue: LiveVenueOption): boolean {
  return venue !== 'KRX';
}

export function liveVenueUsesExtendedMinuteWindow(venue: LiveVenueOption): boolean {
  return venue !== 'KRX';
}

function isKstWeekday(yyyymmdd: string): boolean {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd !== 0 && wd !== 6;
}

/** NXT/Integrated/AUTO minute display window (08:00-20:00 KST). */
export function extendedVenueSessionOpenMs(yyyymmdd: string): number {
  return regularSessionOpenMs(yyyymmdd) - 60 * 60 * 1000;
}

export function extendedVenueSessionCloseMs(yyyymmdd: string): number {
  return regularSessionOpenMs(yyyymmdd) + 11 * 3600 * 1000;
}

export function liveVenueSessionBoundsMs(
  yyyymmdd: string,
  venue: LiveVenueOption,
): { open_ms: number; close_ms: number } {
  if (!liveVenueUsesExtendedMinuteWindow(venue)) {
    return { open_ms: regularSessionOpenMs(yyyymmdd), close_ms: regularSessionCloseMs(yyyymmdd) };
  }
  return { open_ms: extendedVenueSessionOpenMs(yyyymmdd), close_ms: extendedVenueSessionCloseMs(yyyymmdd) };
}

export function isLiveVenueSessionNow(venue: LiveVenueOption, nowMs: number = Date.now()): boolean {
  if (venue === 'KRX') return isKrxRegularSessionNow(nowMs);
  const today = realMsToYyyymmdd(nowMs);
  if (!isKstWeekday(today)) return false;
  const { open_ms, close_ms } = liveVenueSessionBoundsMs(today, venue);
  return nowMs >= open_ms && nowMs <= close_ms;
}

export function liveVenueRefetchInterval(venue: LiveVenueOption): 60_000 | false {
  return isLiveVenueSessionNow(venue) ? 60_000 : false;
}

export function liveVenueAllowsKrxTradeOverlay(venue: LiveVenueOption, tMs: number): boolean {
  if (venue === 'KRX') return true;
  if (venue !== 'AUTO') return false;
  const tradeDate = realMsToYyyymmdd(tMs);
  return tMs >= regularSessionOpenMs(tradeDate) && tMs <= regularSessionCloseMs(tradeDate);
}

export function initialVisibleMinuteBarsFor(
  tf: LiveTimeframe,
  venue: LiveVenueOption,
): number {
  if (!isMinuteTimeframe(tf)) return 300;
  if (!liveVenueUsesExtendedMinuteWindow(venue)) return 300;
  const tfMinutes = TIMEFRAME_TO_MS[tf] / 60_000;
  return Math.ceil(EXTENDED_SESSION_MINUTES / tfMinutes);
}
