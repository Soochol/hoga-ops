import type { Candle, InvestorNetPoint, RangeBundle, VolumeProfile } from '../api/types';
import type { LiveIndexCandle } from '../api/liveIndices';
import type { LiveIndexId } from './liveInstrument';
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
  const candles: Candle[] = input.candles.map((c) => ({
    ts_ms: c.t_ms,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    vol_a: c.volume,
    vol_b: 0,
  }));
  const dates = Array.from(new Set(input.candles.map((c) => realMsToYyyymmdd(c.t_ms))));
  return {
    code: `index:${input.indexId}`,
    from_date: input.from,
    to_date: input.to,
    bucket_ms: input.bucketMs,
    segments: dates.map((date) => ({
      date,
      session_open_ms: regularSessionOpenMs(date),
      session_close_ms: regularSessionCloseMs(date),
    })),
    candles,
    quote_ratio: { bucket_ms: input.bucketMs, points: [] },
    fill_strength: { bucket_ms: input.bucketMs, points: [] },
    volume_profile_range: EMPTY_VOLUME_PROFILE,
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: input.investorPoints ?? [],
    ask_peaks: [],
    bid_peaks: [],
  };
}
