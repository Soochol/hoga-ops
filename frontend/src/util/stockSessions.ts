import { unixMsToKSTDate, unixMsToKSTHhmm } from './time';

/** Mirror of hoga/live/stock_sessions.py. Market hours do not imply eligibility. */
export const KRX_AFTERMARKET_START_DATE = '20260914';

export function krxAftermarketIntroduced(date: string): boolean {
  return date >= KRX_AFTERMARKET_START_DATE;
}

/** The display window can end at 20:00; the official auction still ends at 15:30. */
export function krxRegularCloseFromWindow(date: string, closeMs: number): number {
  if (!krxAftermarketIntroduced(date)) return closeMs;
  const midnight = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)), -9);
  return Math.min(closeMs, midnight + (15 * 60 + 30) * 60_000);
}

export function isKrxAftermarketWindow(nowMs: number = Date.now()): boolean {
  const day = new Date(nowMs + 9 * 3600_000).getUTCDay();
  const hhmm = unixMsToKSTHhmm(nowMs);
  return day !== 0 && day !== 6 && krxAftermarketIntroduced(unixMsToKSTDate(nowMs))
    && hhmm >= 1600 && hhmm < 2000;
}

/** Show the session of the actual ladder, never infer participation from NXT. */
export function krxBookPhaseLabel(nowMs: number, ladderAtMs?: number | null): string {
  const hhmm = unixMsToKSTHhmm(nowMs);
  if (hhmm < 1530) return '정규장';
  if (hhmm < 1600) return '정규장 · 마지막';
  const observed = ladderAtMs != null
    && unixMsToKSTDate(ladderAtMs) === unixMsToKSTDate(nowMs)
    && unixMsToKSTHhmm(ladderAtMs) >= 1600;
  if (!observed) return isKrxAftermarketWindow(nowMs) ? '애프터마켓 · 수신 대기' : '정규장 · 마지막';
  return isKrxAftermarketWindow(nowMs) ? '애프터마켓' : '애프터마켓 · 마지막';
}


export function indicatorBucketStartMs(tMs: number, bucketMs: number, venue: string = 'KRX'): number {
  if (bucketMs >= 2 * 3600_000 && venue === 'KRX' && isKrxAftermarketWindow(tMs)) {
    const midnight = Math.floor((tMs + 9 * 3600_000) / 86400_000) * 86400_000 - 9 * 3600_000;
    const anchor = midnight + 16 * 3600_000;
    return anchor + Math.floor((tMs - anchor) / bucketMs) * bucketMs;
  }
  return Math.floor(tMs / bucketMs) * bucketMs;
}
