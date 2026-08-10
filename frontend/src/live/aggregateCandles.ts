import type { LivePastCandle as LiveCandle } from '../api/livePastCandles';
import { realMsToYyyymmdd, regularSessionOpenMs, regularSessionCloseMs } from './liveDateTime';

/** 이 시각이 자기 날짜의 정규장 `[09:00, 15:30]` KST 안인가.
 *
 * **정규장 클립의 단일 술어다.** 세 호출자가 이것 하나를 본다: 캘린더(D/W/M)
 * 집계, 120·240분 과거봉 클립, 그리고 그 두 tf 의 실시간 체결 오버레이. 셋이
 * 각자 경계를 재계산하면 "과거봉은 잘렸는데 실시간 tail 은 안 잘린" 상태가
 * 장중에만 나타나 재현이 어렵다.
 *
 * ⚠ **반휴장일(12:30 마감)은 못 본다.** 고정 09:00~15:30 이라 12:30 이후 시간외가
 * 창 안에 들어오면 통과시킨다. `effective_sessions` 를 쓰면 정확해지지만 그 값은
 * **venue 세션**이지 정규장이 아니다 — NXT 는 08:00~20:00 으로 와서 클립 기준으로
 * 쓰면 아무것도 안 잘린다(2026-08-07 실측). 이 한계는 `keepRegularSessionCandles`
 * 가 D/W/M 에서 이미 갖고 있던 것과 같고, 새 술어를 만드는 대신 공유한다. */
export function isRegularSessionMs(tMs: number): boolean {
  const date = realMsToYyyymmdd(tMs);
  return tMs >= regularSessionOpenMs(date) && tMs <= regularSessionCloseMs(date);
}

/** Drop bars outside the regular session [09:00, 15:30] KST for their own date.
 * Calendar (D/W/M) aggregation runs on this so pre/post-market minute bars do
 * not skew the day's OHLC. Generic over `{t_ms}` so it applies to raw KIS bars
 * and Candle-shaped rows alike. */
export function keepRegularSessionCandles<T extends { t_ms: number }>(candles: readonly T[]): T[] {
  return candles.filter((c) => isRegularSessionMs(c.t_ms));
}

/** OHLCV aggregation of a sorted candle stream into `bucketSeconds`-sized
 * buckets, aligned to the Unix epoch.
 *
 * 입력 해상도는 `bucketSeconds` **이하**면 된다 — 이미 목표 버킷으로 잘린 봉에는
 * 멱등(재격자화만)이다. /live 분봉 경로가 이 성질에 기댄다: 과거분은 벤더가 표시 tf
 * 로 잘라 주고(#1008) 오늘분은 1분이라, 혼합 스트림 하나가 이 함수를 한 번 지나
 * 같은 격자로 수렴한다. 멱등성의 전제는 입력 봉 시작이 버킷 경계에 정렬돼 있다는
 * 것 — KST 09:00 격자와 epoch-floor 가 일치하는 tf(현행 6종 전부)에서만 참이다.
 *
 * Inputs may arrive in either order (vendors return DESC; our hydrate also
 * de-duplicates) — the caller is expected to pre-sort ascending. We assert
 * that here only via the bucket-floor monotonicity check; out-of-order input
 * silently produces wrong open/close, so callers must respect the contract.
 *
 * Bucket time is the bucket-start in seconds (UTCTimestamp shape) — matches
 * what lightweight-charts expects. Zero-volume source bars are kept (they
 * carry a price snapshot even with no trades), so empty buckets are only
 * those with no source bars at all.
 */
export interface AggregatedCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function aggregateCandles(
  source: readonly LiveCandle[],
  bucketSec: number,
): AggregatedCandle[] {
  if (bucketSec <= 0) throw new Error(`bucketSec must be positive, got ${bucketSec}`);
  if (source.length === 0) return [];
  const bucketMs = bucketSec * 1000;
  const out: AggregatedCandle[] = [];
  let cur: AggregatedCandle | null = null;
  for (const c of source) {
    const bucketStart = Math.floor(c.t_ms / bucketMs) * bucketMs;
    if (cur === null || bucketStart !== cur.t_ms) {
      if (cur !== null) out.push(cur);
      cur = {
        t_ms: bucketStart,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Calendar-based bucket key for the KST date that owns `t_ms`. Returns a
 * string so D/W/M can all use string equality (epoch-floor breaks W & M
 * because their period lengths vary with month boundaries and leap weeks).
 * KST = UTC+9; shift first, then read calendar fields. */
export function calendarBucketKey(t_ms: number, granularity: 'D' | 'W' | 'M'): string {
  const kst = new Date(t_ms + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  if (granularity === 'M') return `${y}-${m}`;
  if (granularity === 'D') return `${y}-${m}-${d}`;
  // W: ISO-ish week starting Monday. JS day 0=Sun..6=Sat; offset to Mon=0..Sun=6.
  const dow = kst.getUTCDay();
  const offsetToMon = (dow + 6) % 7;
  const monday = new Date(Date.UTC(y, m, d - offsetToMon));
  return `W:${monday.getUTCFullYear()}-${monday.getUTCMonth()}-${monday.getUTCDate()}`;
}

/** OHLCV aggregation into calendar-aligned buckets (Day / Week / Month) in
 * KST. Unlike `aggregateCandles`, the result's `t_ms` is the **first source
 * bar's timestamp** for that bucket — i.e. the trading session's opening
 * minute. This keeps the aggregated point inside the owning Segment's
 * `[sessionOpenMs, sessionCloseMs]` so `axis.contains` admits it. The
 * alternative (synthetic midnight / Monday-midnight / month-first-midnight)
 * would land in a Gap and get filtered out.
 *
 * Inputs MUST be sorted ascending by `t_ms`; caller's contract, same as
 * `aggregateCandles`.
 */
export function aggregateCalendar(
  source: readonly LiveCandle[],
  granularity: 'D' | 'W' | 'M',
): AggregatedCandle[] {
  if (source.length === 0) return [];
  const out: AggregatedCandle[] = [];
  let cur: AggregatedCandle | null = null;
  let curKey: string | null = null;
  for (const c of source) {
    const key = calendarBucketKey(c.t_ms, granularity);
    if (curKey === null || key !== curKey) {
      if (cur !== null) out.push(cur);
      curKey = key;
      cur = {
        t_ms: c.t_ms,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
    } else if (cur !== null) {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}
