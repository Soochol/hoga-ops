import type { RangeBundle, VolumeProfile } from '../api/types';
import type { StudySnapshotBundle } from '../api/studyViews';
import { bucketSeconds } from '../state/livePage';

export type StudySnapshotRatioPoint = { t: number; value: number };
export type StudySnapshotRatio = { bucket_ms: number; points: StudySnapshotRatioPoint[] };
export type StudySnapshotRangeBundle = RangeBundle & {
  /**
   * Display-locked ratio values saved with the study snapshot. Kept separate
   * from RangeBundle.quote_ratio because quote totals and ratio display can be
   * captured under different aggregation settings.
   */
  study_ratio: StudySnapshotRatio;
};

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

export function studySnapshotBundleToRangeBundle(snapshot: StudySnapshotBundle): StudySnapshotRangeBundle {
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
          bid_max: 0,
          ask_max: 0,
          imb_max_bid: 0,
          imb_max_ask: 0,
        }];
      }),
    },
    study_ratio: {
      bucket_ms,
      points: snapshot.ratio.flatMap((p) => {
        if (!p.visible || p.value == null) return [];
        return [{ t: p.t, value: p.value }];
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
