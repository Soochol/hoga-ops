import type { SecondPrice } from '../../api/secondAggregates';
import type { DayVolumeDistribution } from '../../api/types';
import { regularSessionOpenMs, regularSessionCloseMs } from '../liveDateTime';
import { isKrxAftermarketWindow } from '../../util/stockSessions';

function before(times: readonly number[], cutoff: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < cutoff) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Time prefixes per price avoid scanning executions during cursor moves.
 * Prefix extrema preserve the existing changing price range at each cutoff.
 * Memory is linear in observed cells, without a copy of every full profile.
 */
export function buildSecondPriceDistributionIndex(prices: readonly SecondPrice[], date: string, rangeCount: number) {
  const open = regularSessionOpenMs(date), close = regularSessionCloseMs(date);
  const trades = prices.filter(p => p.side !== 0 && (p.t_ms >= open && p.t_ms <= close || isKrxAftermarketWindow(p.t_ms)))
    .sort((a, b) => a.t_ms - b.t_ms);
  const times: number[] = [], mins: number[] = [], maxs: number[] = [];
  const byPrice = new Map<number, { times: number[]; quantities: number[] }>();
  let min = Infinity, max = -Infinity;
  for (const trade of trades) {
    times.push(trade.t_ms);
    mins.push(min = Math.min(min, trade.price));
    maxs.push(max = Math.max(max, trade.price));
    let level = byPrice.get(trade.price);
    if (!level) { level = { times: [], quantities: [] }; byPrice.set(trade.price, level); }
    level.times.push(trade.t_ms);
    level.quantities.push((level.quantities.at(-1) ?? 0) + trade.qty);
  }
  return {
    profileAt(cutoffExclusive: number | null = null): DayVolumeDistribution | null {
      const end = cutoffExclusive === null ? times.length : before(times, cutoffExclusive);
      if (!end) return null;
      const min = mins[end - 1], max = maxs[end - 1], last = times[end - 1];
      const width = (max - min) / rangeCount || 1;
      const bins = Array.from({ length: rangeCount }, (_, i) => ({
        price_low: min + i * width, price_high: i === rangeCount - 1 ? max : min + (i + 1) * width, qty: 0,
      }));
      for (const [price, level] of byPrice) {
        if (price < min || price > max) continue;
        const end = cutoffExclusive === null ? level.times.length : before(level.times, cutoffExclusive);
        if (end) bins[Math.min(rangeCount - 1, Math.floor((price - min) / width))].qty += level.quantities[end - 1];
      }
      return { date, range_count: rangeCount, price_min: min, price_max: max,
        session_open_ms: open, session_close_ms: Math.max(close, last + 1000), last_trade_ms: last, bins };
    },
  };
}
