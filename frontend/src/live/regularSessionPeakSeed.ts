import type { AskPeak, Candle } from '../api/types';
import { regularSessionOpenMs, regularSessionCloseMs } from './liveDateTime';
import type { LiveTodayAskPeak } from '../api/liveSeries';

/** The live server ratchet covers the full venue window. A regular-only chart
 * seeds its ratchet from the separately aggregated /range result instead. */
export function regularSessionPeakSeed(
  seed: AskPeak | null | undefined, candles: readonly Candle[], date: string, side: 'ask' | 'bid',
): LiveTodayAskPeak | null {
  if (!seed) return null;
  const all = seed.all_max_peaks?.length ? seed.all_max_peaks : seed.all_peaks ?? [];
  const traded = seed.traded_max_peaks?.length ? seed.traded_max_peaks : seed.traded_peaks ?? [];
  const open = regularSessionOpenMs(date), close = regularSessionCloseMs(date);
  let extreme: number | null = null;
  for (const c of candles) {
    if (c.ts_ms < open || c.ts_ms > close) continue;
    const price = side === 'ask' ? c.high : c.low;
    extreme = extreme == null ? price : side === 'ask' ? Math.max(extreme, price) : Math.min(extreme, price);
  }
  return {
    date, coverage: 'partial',
    traded_price: traded[0]?.price ?? seed.price,
    traded_qty: traded[0]?.qty ?? seed.qty,
    traded_t_ms: traded[0]?.t_ms ?? seed.t_ms,
    all_price: all[0]?.price ?? seed.max_price ?? 0,
    all_qty: all[0]?.qty ?? seed.max_qty ?? 0,
    all_t_ms: all[0]?.t_ms ?? seed.max_t_ms ?? 0,
    all_peaks: all, traded_peaks: traded,
    unreached_peaks: seed.unreached_peaks,
    traded_record_peaks: seed.traded_record_peaks,
    all_record_peaks: seed.all_record_peaks,
    traded_bar_peaks: seed.traded_bar_peaks,
    all_bar_peaks: seed.all_bar_peaks,
    unreached_bar_peaks: seed.unreached_bar_peaks,
    day_extreme: extreme,
  };
}
