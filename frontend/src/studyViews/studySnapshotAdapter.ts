import type { RangeBundle, VolumeProfile } from '../api/types';
import type { StudySnapshotBundle } from '../api/studyViews';
import { bucketSeconds } from '../state/livePage';

const EMPTY_VOLUME_PROFILE: VolumeProfile = {
  bin_count: 0,
  price_min: 0,
  price_max: 0,
  bin_width: 0,
  bins: [],
};

function bucketMsFor(snapshot: StudySnapshotBundle): number {
  return (bucketSeconds(snapshot.timeframe) ?? 60) * 1000;
}

export function studySnapshotBundleToRangeBundle(snapshot: StudySnapshotBundle): RangeBundle {
  const bucket_ms = bucketMsFor(snapshot);
  const firstSegment = snapshot.segments[0];
  const lastSegment = snapshot.segments[snapshot.segments.length - 1];

  return {
    code: snapshot.code,
    from_date: firstSegment?.date ?? '',
    to_date: lastSegment?.date ?? '',
    bucket_ms,
    segments: snapshot.segments,
    candles: snapshot.candles.map((c) => ({
      ts_ms: c.t,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      vol_a: c.volume,
      vol_b: 0,
    })),
    quote_ratio: {
      bucket_ms,
      points: snapshot.quote_totals.flatMap((p) => {
        if (!p.visible || p.bid_total == null || p.ask_total == null) return [];
        return [{
          t: p.t,
          bid_total: p.bid_total,
          ask_total: p.ask_total,
          bid_max: p.bid_total,
          ask_max: p.ask_total,
          imb_max_bid: p.bid_total,
          imb_max_ask: p.ask_total,
        }];
      }),
    },
    fill_strength: {
      bucket_ms,
      points: snapshot.fill_strength.flatMap((p) => {
        if (!p.visible || p.buy_qty == null || p.sell_qty == null) return [];
        return [{ t: p.t, buy_qty: p.buy_qty, sell_qty: p.sell_qty }];
      }),
    },
    volume_profile_range: EMPTY_VOLUME_PROFILE,
    volume_profile_by_day: [],
    investorPoints: [],
    ask_peaks: [],
  };
}
