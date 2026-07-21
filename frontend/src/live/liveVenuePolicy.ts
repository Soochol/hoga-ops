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

/**
 * 체결/호가 스냅샷의 시장 태그(tagVenue)가 선택된 캔들 venue의 시장 구성에 속해
 * 오버레이·현재가 라인에 반영돼도 되는지 판정한다(#523 — ADR-0096 시간 게이트를
 * venue 태그 매칭으로 대체).
 *
 *  - **KRX venue**: KRX 태그만 수용(태그 부재=KRX 하위호환). NXT 태그는 KRX 캔들에
 *    섞지 않는다.
 *  - **자동(UN) venue**: 태그가 있으면 KRX·NXT 둘 다 수용 — 백엔드가 시분할 구독
 *    하므로 시점당 한 시장(정규장=KRX, 그 외=NXT)만 도착한다(#524). 태그가 없으면
 *    (구백엔드) ADR-0096 시간 게이트로 폴백: 정규장 KRX 체결만.
 *  - **그 외**(제거된 NXT 등): 미수용.
 *
 * tagVenue는 TradeSnapshot/ObSnapshot.venue(백엔드 태그). undefined면 구백엔드로 간주.
 */
export function liveVenueAllowsTradeOverlay(
  selectedVenue: LiveVenueOption,
  tagVenue: 'KRX' | 'NXT' | undefined,
  tMs: number,
): boolean {
  const tag = tagVenue ?? 'KRX';
  if (selectedVenue === 'KRX') return tag === 'KRX';
  if (selectedVenue === 'UN') {
    if (tagVenue === undefined) {
      const date = realMsToYyyymmdd(tMs);
      return tMs >= regularSessionOpenMs(date) && tMs <= regularSessionCloseMs(date);
    }
    return tag === 'KRX' || tag === 'NXT';
  }
  return false;
}

/**
 * 상태바 "호가 {KRX|NXT}" 배지가 반영할 현재 호가 수신 시장(#523). 백엔드 시분할
 * 구독(정규장=KRX, 그 밖 NXT)을 시계로 근사한다. KRX venue는 항상 KRX(배지 없음 —
 * liveVenueKeepsHogaKrx=false). warmup/drain 경계(±수분)의 근사 오차는 표시상 무해.
 */
export function liveHogaVenueNow(
  selectedVenue: LiveVenueOption,
  nowMs: number = Date.now(),
): 'KRX' | 'NXT' {
  if (selectedVenue === 'KRX') return 'KRX';
  return isKrxRegularSessionNow(nowMs) ? 'KRX' : 'NXT';
}

export function initialVisibleMinuteBarsFor(
  tf: LiveTimeframe,
  _venue: LiveVenueOption,
): number {
  if (!isMinuteTimeframe(tf)) return 300;
  return 300;
}
