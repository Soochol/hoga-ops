import type { Candle, InvestorNetPoint, RangeBundle, VolumeProfile } from '../api/types';
import type { LiveIndexCandle } from '../api/liveIndices';
import { indexWorkareaCode, isUsIndexId, type LiveIndexId } from './liveInstrument';
import {
  realMsToYyyymmdd,
  regularSessionCloseMs,
  regularSessionOpenMs,
} from './liveDateTime';

const EMPTY_VOLUME_PROFILE: VolumeProfile = {
  bin_count: 0,
  price_min: 0,
  price_max: 0,
  bin_width: 0,
  bins: [],
};

export function buildIndexBundle(input: {
  indexId: LiveIndexId;
  from: string;
  to: string;
  bucketMs: number;
  candles: LiveIndexCandle[];
  investorPoints?: InvestorNetPoint[];
}): RangeBundle {
  return buildPriceBundle({ ...input, code: indexWorkareaCode(input.indexId), observedSessions: isUsIndexId(input.indexId) && input.bucketMs < 86_400_000 });
}

export function buildPriceBundle(input: { observedSessions?: boolean; code: string; from: string; to: string; bucketMs: number; candles: LiveIndexCandle[]; investorPoints?: InvestorNetPoint[] }): RangeBundle {
  const candles: Candle[] = input.candles.map((c) => ({
    ts_ms: c.t_ms,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    vol_a: c.volume,
    vol_b: 0,
    ...(c.trade_value_won != null ? { trade_value_won: c.trade_value_won } : {}),
  }));
  const dates = Array.from(new Set(input.candles.map((c) => c.trading_date ?? realMsToYyyymmdd(c.t_ms))));
  const segments = dates.map((date) => ({
    date,
    // Foreign sessions cross KST midnight; group actual instants by NY trading date.
    session_open_ms: input.observedSessions ? Math.min(...input.candles.filter(c => c.trading_date === date).map(c => c.t_ms)) : regularSessionOpenMs(date),
    session_close_ms: input.observedSessions ? Math.max(...input.candles.filter(c => c.trading_date === date).map(c => c.t_ms)) + input.bucketMs : regularSessionCloseMs(date),
  }));
  if (input.observedSessions) {
    // Native extended-hours buckets can abut the next business day's first
    // bar. Session bounds are inclusive: leave one second for the axis gap.
    for (let i = 0; i < segments.length - 1; i++) {
      segments[i].session_close_ms = Math.min(segments[i].session_close_ms, segments[i + 1].session_open_ms - 1000);
    }
  }
  return {
    code: input.code,
    from_date: input.from,
    to_date: input.to,
    bucket_ms: input.bucketMs,
    segments,
    candles,
    quote_ratio: { bucket_ms: input.bucketMs, points: [] },
    fill_strength: { bucket_ms: input.bucketMs, points: [] },
    volume_profile_range: EMPTY_VOLUME_PROFILE,
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: input.investorPoints ?? [],
    ask_peaks: [],
    bid_peaks: [],
    broker_late_entries: [],
    depth_heatmap: [],
  };
}
