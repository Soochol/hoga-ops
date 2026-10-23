import { useEffect } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UsDailyBar } from './usDailyCandles';
import type { Candle, RangeBundle } from './types';
import { subscribeEvents, subscribeUsStock } from './ws';
import { regularSessionCloseMs, regularSessionOpenMs } from '../live/liveDateTime';

export interface UsObservedMinute extends UsDailyBar { observed_at_ms: number }
export interface UsStockCandleEvent {
  type: 'us_stock_candles';
  instrument_key: string;
  generation: string;
  sequence: number;
  status: string;
  checked_at_ms: number;
  minutes: UsObservedMinute[];
  daily: UsDailyBar | null;
}

export function mergeUsObservations(previous: UsStockCandleEvent | undefined, next: UsStockCandleEvent): UsStockCandleEvent {
  if (previous?.instrument_key !== next.instrument_key) return next;
  if (previous.generation === next.generation && previous.sequence > next.sequence) return previous;
  if (previous.generation === next.generation && previous.sequence === next.sequence && previous.status === next.status
    && previous.checked_at_ms === next.checked_at_ms && previous.minutes.length >= next.minutes.length) return previous;
  const day = next.daily?.trading_date ?? previous.daily?.trading_date;
  const minutes = new Map<number, UsObservedMinute>();
  for (const row of previous.minutes) if (row.trading_date === day) minutes.set(row.t_ms, row);
  for (const row of next.minutes) if (row.trading_date === day) minutes.set(row.t_ms, row);
  return { ...next, checked_at_ms: next.daily ? next.checked_at_ms : previous.checked_at_ms,
    daily: next.daily ?? previous.daily, minutes: [...minutes.values()].sort((a, b) => a.t_ms - b.t_ms).slice(-391) };
}

export function useUsStockRealtime(exchange: string | null, symbol: string | null) {
  const client = useQueryClient();
  const key = ['live', 'us-stock-realtime', exchange, symbol];
  const query = useQuery<UsStockCandleEvent>({ queryKey: key, queryFn: skipToken, gcTime: 300_000 });
  useEffect(() => {
    if (!exchange || !symbol) return;
    const queryKey = ['live', 'us-stock-realtime', exchange, symbol];
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ['live', 'us-stock-minute', exchange, symbol] }, { cancelRefetch: false });
      void client.invalidateQueries({ queryKey: ['live', 'us-stock-daily', exchange, symbol] }, { cancelRefetch: false });
    };
    const release = subscribeUsStock(exchange, symbol, event => {
      const previous = client.getQueryData<UsStockCandleEvent>(queryKey);
      client.setQueryData(queryKey, mergeUsObservations(previous, event));
      if (previous && previous.generation !== event.generation && event.status === 'streaming') refresh();
    });
    const releaseEvents = subscribeEvents(event => { if (event.type === 'connected') refresh(); });
    return () => { release(); releaseEvents(); };
  }, [client, exchange, symbol]);
  return query.data;
}

function lowerBound(candles: Candle[], stamp: number) {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (candles[mid].ts_ms < stamp) lo = mid + 1; else hi = mid; }
  return lo;
}

const segmentCache = new WeakMap<RangeBundle, RangeBundle['segments']>();

/** Keep immutable history references and segment layout; only project observed tail rows. */
export function overlayUsBundle(base: RangeBundle | null, live: UsStockCandleEvent | undefined,
  timeframe: string, restStartedMs: number, requestedTo: string): RangeBundle | null {
  if (!base || !live?.daily || live.instrument_key !== base.code || live.daily.trading_date > requestedTo
    || live.daily.trading_date < base.from_date || (!timeframe.endsWith('m') && timeframe !== 'D')) return base;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
  if (live.daily.trading_date !== today) return base;
  const patches = new Map<number, UsObservedMinute>();
  const bucket = Number(timeframe.slice(0, -1)) * 60_000;
  if (timeframe === 'D') patches.set(live.daily.t_ms, { ...live.daily, observed_at_ms: live.checked_at_ms });
  else for (const row of live.minutes) {
    const stamp = Math.floor(row.t_ms / bucket) * bucket;
    // A newer row in the same native bucket must not revive corrected older minutes.
    const baseline = base.candles[lowerBound(base.candles, stamp)];
    if (baseline?.ts_ms === stamp && row.observed_at_ms < restStartedMs) continue;
    const existing = patches.get(stamp);
    patches.set(stamp, existing ? { ...existing, high: Math.max(existing.high, row.high),
      low: Math.min(existing.low, row.low), close: row.close, observed_at_ms: row.observed_at_ms } : { ...row, t_ms: stamp });
  }
  let candles: Candle[] | null = null;
  for (const [stamp, row] of patches) {
    const index = lowerBound(candles ?? base.candles, stamp);
    const original = (candles ?? base.candles)[index];
    const same = original?.ts_ms === stamp;
    if (same && row.observed_at_ms < restStartedMs) continue;
    const next: Candle = same ? { ...original, high: Math.max(original.high, row.high),
      low: Math.min(original.low, row.low), close: row.close } : { ts_ms: stamp, open: row.open,
      high: row.high, low: row.low, close: row.close, vol_a: 0, vol_b: 0 };
    if (same && original.high === next.high && original.low === next.low && original.close === next.close) continue;
    candles ??= base.candles.slice();
    if (same) candles[index] = next;
    else candles.splice(index, 0, next);
  }
  if (!candles) return base;
  const day = live.daily.trading_date;
  let segments = base.segments.slice();
  const last = segments.at(-1);
  const tail = candles.at(-1)!;
  if (timeframe === 'D') {
    if (last?.date !== day) segments.push({ date: day, session_open_ms: regularSessionOpenMs(day), session_close_ms: regularSessionCloseMs(day) });
  } else if (last?.date === day) {
    if (tail.ts_ms + bucket > last.session_close_ms) segments[segments.length - 1] = { ...last, session_close_ms: tail.ts_ms + bucket };
  } else segments.push({ date: day, session_open_ms: Math.min(...patches.keys()), session_close_ms: tail.ts_ms + bucket });
  const cached = segmentCache.get(base) ?? base.segments;
  if (cached.length === segments.length && cached.every((s, i) => s.date === segments[i].date
    && s.session_open_ms === segments[i].session_open_ms && s.session_close_ms === segments[i].session_close_ms)) segments = cached;
  else segmentCache.set(base, segments);
  return { ...base, to_date: day, candles, segments };
}
