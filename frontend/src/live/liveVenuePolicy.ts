import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import { LIVE_VENUE_LABELS, type LiveVenueOption } from '../state/liveVenue';
import type { LiveEffectiveSession } from '../api/livePastCandles';
import {
  isKrxRegularSessionNow,
  realMsToYyyymmdd,
  regularSessionCloseMs,
  regularSessionOpenMs,
} from './liveDateTime';

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

/** NXT/Integrated minute display window (08:00-20:00 KST). */
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

export function effectiveSessionBoundsByDate(
  effectiveSessions: readonly LiveEffectiveSession[] | undefined,
): Map<string, { open_ms: number; close_ms: number }> {
  const out = new Map<string, { open_ms: number; close_ms: number }>();
  for (const session of effectiveSessions ?? []) {
    if (
      typeof session.date === 'string' &&
      Number.isFinite(session.open_ms) &&
      Number.isFinite(session.close_ms) &&
      session.open_ms < session.close_ms
    ) {
      out.set(session.date, { open_ms: session.open_ms, close_ms: session.close_ms });
    }
  }
  return out;
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

/** 통합(UN) venue의 하이브리드 정의(ADR-0096): KRX 정규장(09:00~15:30)에는
 * KRX WS 체결을 실시간 정본으로 쓰고, 그 밖(NXT 전용 시간대)은 통합 REST
 * 폴링(NXT 체결 반영)에 맡긴다. 정규장 중 KRX≈통합 가격이라 오차는 미미하고,
 * 60초 통합 REST 재조회가 캔들을 계속 정본으로 덮어써 자가 수정된다.
 * NXT venue는 NXT 단독 캔들이라 KRX 체결을 섞지 않는다. */
export function liveVenueAllowsKrxTradeOverlay(venue: LiveVenueOption, tMs: number): boolean {
  if (venue === 'KRX') return true;
  if (venue !== 'UN') return false;
  const date = realMsToYyyymmdd(tMs);
  return tMs >= regularSessionOpenMs(date) && tMs <= regularSessionCloseMs(date);
}

export function initialVisibleMinuteBarsFor(
  tf: LiveTimeframe,
  _venue: LiveVenueOption,
): number {
  if (!isMinuteTimeframe(tf)) return 300;
  return 300;
}
