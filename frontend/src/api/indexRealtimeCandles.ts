import type { LiveTimeframe } from '../state/livePage';
import { isMinuteTimeframe } from '../state/livePage';
import { isUsIndexId, type LiveIndexId } from '../live/liveInstrument';
import { isKstWeekend, realMsToYyyymmdd, regularSessionCloseMs, regularSessionOpenMs } from '../live/liveDateTime';
import type { LiveIndexCandle, LiveIndexCandlesResponse } from './liveIndices';

const MINUTE_MS = 60_000;
const MAX_SESSION_MINUTES = 391; // 09:00 through the provider's 15:30 closing bucket.
interface PriceSample { tMs: number; value: number }
interface ObservedMinute { startMs: number; samples: PriceSample[] }
export interface IndexRealtimeSession {
  indexId: LiveIndexId;
  date: string;
  lastMs: number;
  minutes: ObservedMinute[];
}

export const indexRealtimeKey = (id: LiveIndexId | null) => ['live', 'index-realtime', id] as const;

/** Observed prices only: no REST values, synthetic gap bars or inferred volume.
 * Keep at most 391 minute chunks, with one observation per broadcast second.
 * Chunking bounds per-tick copying to the minute index and the current minute.
 */
export function appendIndexPrice(
  previous: IndexRealtimeSession | undefined, indexId: LiveIndexId,
  tick: { value?: number; t_ms?: number }, nowMs: number,
): IndexRealtimeSession | undefined {
  const { value, t_ms: tMs } = tick;
  if (isUsIndexId(indexId) || indexId === 'KRX100' || indexId === 'KRX300'
    || value == null || !Number.isFinite(value) || value <= 0 || tMs == null || !Number.isFinite(tMs)
    || tMs > nowMs + MINUTE_MS || nowMs - tMs > 3 * MINUTE_MS) return previous;
  const date = realMsToYyyymmdd(tMs);
  if (date !== realMsToYyyymmdd(nowMs) || isKstWeekend(date)
    || tMs < regularSessionOpenMs(date) || tMs > regularSessionCloseMs(date)
    || (previous?.indexId === indexId && tMs < previous.lastMs)) return previous;
  const sameDay = previous?.indexId === indexId && previous.date === date;
  const minutes = sameDay ? previous.minutes : [];
  const last = minutes.at(-1);
  const startMs = Math.floor(tMs / MINUTE_MS) * MINUTE_MS;
  if (last?.startMs === startMs) {
    const sample = last.samples.at(-1)!;
    if (sample.tMs === tMs && sample.value === value) return previous;
    // The server broadcasts at 1 Hz; replacing an equal-second observation
    // bounds memory even when duplicate or corrected frames arrive.
    const samples = Math.floor(sample.tMs / 1000) === Math.floor(tMs / 1000) ? last.samples.slice(0, -1) : last.samples;
    return { indexId, date, lastMs: tMs,
      minutes: [...minutes.slice(0, -1), { startMs, samples: [...samples, { tMs, value }] }] };
  }
  return { indexId, date, lastMs: tMs,
    minutes: [...minutes, { startMs, samples: [{ tMs, value }] }].slice(-MAX_SESSION_MINUTES) };
}

function calendarKey(date: string, timeframe: LiveTimeframe): string {
  if (timeframe === 'M') return date.slice(0, 6);
  if (timeframe !== 'W') return date;
  const day = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10).replaceAll('-', '');
}

/** REST owns completed bars and volume. Apply newer observations to its tail;
 * bars absent from REST may use only prices actually observed in that bucket.
 * A successful later REST request replaces completed provisional bars.
 */
export function overlayIndexCandles(
  response: LiveIndexCandlesResponse, session: IndexRealtimeSession | undefined,
  restStartedAtMs: number,
): LiveIndexCandlesResponse {
  if (!session || session.indexId !== response.index_id || isUsIndexId(response.index_id)
    || session.date < response.from || session.date > response.to) return response;
  const tf = response.timeframe;
  const minute = isMinuteTimeframe(tf);
  if (!minute && tf !== 'D' && tf !== 'W' && tf !== 'M') return response;
  const bucketMs = minute ? Number(tf.slice(0, -1)) * MINUTE_MS : 0;
  const last = response.candles.at(-1);
  const targetKey = calendarKey(session.date, tf);
  const calendarLastMatches = last && calendarKey(last.trading_date ?? realMsToYyyymmdd(last.t_ms), tf) === targetKey;
  const observedByTime = new Map<number, LiveIndexCandle>();
  const existing = new Map(response.candles.map(c => [c.t_ms, c]));
  for (const observed of session.minutes) {
    const bucket = minute ? Math.floor(observed.startMs / bucketMs) * bucketMs
      : calendarLastMatches ? last.t_ms : regularSessionOpenMs(session.date);
    if (last && bucket < last.t_ms) continue;
    for (const sample of observed.samples) {
      if (existing.has(bucket) && sample.tMs < restStartedAtMs) continue;
      const aggregate = observedByTime.get(bucket);
      if (aggregate) {
        aggregate.high = Math.max(aggregate.high, sample.value);
        aggregate.low = Math.min(aggregate.low, sample.value);
        aggregate.close = sample.value;
      } else observedByTime.set(bucket, { t_ms: bucket, open: sample.value,
        high: sample.value, low: sample.value, close: sample.value, volume: 0 });
    }
  }
  if (!observedByTime.size) return response;
  const candles: LiveIndexCandle[] = [...response.candles];
  for (const [t_ms, observed] of observedByTime) {
    const base = existing.get(t_ms);
    const next: LiveIndexCandle = base ? { ...base, high: Math.max(base.high, observed.high),
      low: Math.min(base.low, observed.low), close: observed.close } : observed;
    if (base && base.high === next.high && base.low === next.low && base.close === next.close) continue;
    if (base) candles[candles.length - 1] = next;
    else candles.push(next);
  }
  return candles.length === response.candles.length && candles.at(-1) === last ? response : { ...response, candles };
}
