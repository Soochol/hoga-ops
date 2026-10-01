import type { UTCTimestamp } from 'lightweight-charts';
import type { SecondBar, SecondPrice } from '../../api/secondAggregates';
import type { DayVolumeDistribution } from '../../api/types';
import { isKrxAftermarketWindow } from '../../util/stockSessions';

const time = (ms: number) => ms / 1000 as UTCTimestamp;
export function movingAverageSeconds(bars: readonly SecondBar[], period: number) {
  let total = 0;
  return bars.flatMap((bar, index) => {
    total += bar.close;
    if (index >= period) total -= bars[index - period].close;
    return index + 1 >= period ? [{ time: time(bar.t_ms), value: total / period }] : [];
  });
}

/** One source for the whole query. No addition of legacy/live quantities. */
export function secondPriceDistribution(prices: readonly SecondPrice[], date: string, rangeCount: number): DayVolumeDistribution | null {
  // Preserve unknown side in storage, exclude it from continuous-trade profile.
  const midnight = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00+09:00`).getTime();
  const trades = prices.filter(p => p.side !== 0 && (p.t_ms >= midnight + 9 * 3_600_000 && p.t_ms <= midnight + 15.5 * 3_600_000 || isKrxAftermarketWindow(p.t_ms)));
  if (!trades.length) return null;
  let min = Infinity, max = -Infinity, lastTrade = 0;
  for (const t of trades) { min = Math.min(min, t.price); max = Math.max(max, t.price); lastTrade = Math.max(lastTrade, t.t_ms); }
  const width = (max - min) / rangeCount || 1;
  const bins = Array.from({ length: rangeCount }, (_, i) => ({ price_low: min + i * width, price_high: i === rangeCount - 1 ? max : min + (i + 1) * width, qty: 0 }));
  for (const trade of trades) bins[Math.min(rangeCount - 1, Math.floor((trade.price - min) / width))].qty += trade.qty;

  return { date, range_count: rangeCount, price_min: min, price_max: max,
    session_open_ms: midnight + 9 * 3_600_000, session_close_ms: Math.max(midnight + 15.5 * 3_600_000, lastTrade + 1000),
    last_trade_ms: lastTrade, bins };
}
