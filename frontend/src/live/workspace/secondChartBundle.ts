import type { RangeBundle, RangeSegment } from '../../api/types';
import type { SecondBar, SecondPrice } from '../../api/secondAggregates';
import { realMsToYyyymmdd } from '../liveDateTime';

const candleCache = new WeakMap<SecondBar, RangeBundle['candles'][number]>();

/** Render adapter only. No minute REST, carried prices or invented trade sides. */
export function secondChartBundle(code: string, date: string, seconds: number, bars: readonly SecondBar[], prices: readonly SecondPrice[] = []): RangeBundle {
  const segments: RangeSegment[] = [];
  const candles = bars.map(bar => {
    const day = realMsToYyyymmdd(bar.t_ms);
    const last = segments.at(-1);
    if (last?.date === day) last.session_close_ms = bar.t_ms;
    else segments.push({ date: day, session_open_ms: bar.t_ms, session_close_ms: bar.t_ms });
    let candle = candleCache.get(bar);
    if (!candle) {
      candle = { ts_ms: bar.t_ms, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        vol_a: bar.volume, vol_b: 0, trade_value_won: bar.trade_value };
      candleCache.set(bar, candle);
    }
    return candle;
  });
  const bucket_ms = seconds * 1000;
  const fill = new Map<number, { t: number; buy_qty: number; sell_qty: number }>();
  for (const cell of prices) {
    if (cell.side === 0) continue;
    const t = Math.floor(cell.t_ms / bucket_ms) * bucket_ms;
    const point = fill.get(t) ?? { t, buy_qty: 0, sell_qty: 0 };
    if (cell.side === 1) point.buy_qty += cell.qty;
    else point.sell_qty += cell.qty;
    fill.set(t, point);
  }
  return { code, from_date: segments[0]?.date ?? date, to_date: date, bucket_ms, segments, candles,
    quote_ratio: { bucket_ms, points: [] }, fill_strength: { bucket_ms, points: [...fill.values()].sort((a, b) => a.t - b.t) },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [], volume_distributions: [], investorPoints: [], ask_peaks: [], broker_late_entries: [] };
}
