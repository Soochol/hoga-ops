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

export type StudySnapshotChartInput = {
  bundle: StudySnapshotRangeBundle;
  chartBundle: StudySnapshotRangeBundle;
  ratioBundle: RangeBundle;
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
          // Study snapshots persist display-locked quote totals, not the raw
          // intra-bucket extrema. Mirror the saved value into the max fields so
          // restored views stay visible when the user has "intra-period max"
          // enabled globally.
          bid_max: p.bid_total,
          ask_max: p.ask_total,
          imb_max_bid: p.bid_total,
          imb_max_ask: p.ask_total,
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

function ratioDisplayToQuoteRatio(studyRatio: StudySnapshotRatio): RangeBundle['quote_ratio'] {
  return {
    bucket_ms: studyRatio.bucket_ms,
    points: studyRatio.points.map((p) => {
      const bid_total = p.value >= 0 ? 1 : 1 - p.value;
      const ask_total = p.value >= 0 ? 1 + p.value : 1;
      return {
        t: p.t,
        bid_total,
        ask_total,
        bid_max: bid_total,
        ask_max: ask_total,
        imb_max_bid: bid_total,
        imb_max_ask: ask_total,
      };
    }),
  };
}

function rangeBundleWithoutStudyRatio(bundle: StudySnapshotRangeBundle): RangeBundle {
  return {
    code: bundle.code,
    from_date: bundle.from_date,
    to_date: bundle.to_date,
    bucket_ms: bundle.bucket_ms,
    segments: bundle.segments,
    candles: bundle.candles,
    quote_ratio: bundle.quote_ratio,
    fill_strength: bundle.fill_strength,
    volume_profile_range: bundle.volume_profile_range,
    volume_profile_by_day: bundle.volume_profile_by_day,
    investorPoints: bundle.investorPoints,
    ask_peaks: bundle.ask_peaks,
  };
}

export function studySnapshotBundleToChartInput(snapshot: StudySnapshotBundle): StudySnapshotChartInput {
  const bundle = studySnapshotBundleToRangeBundle(snapshot);
  const ratioBundle: RangeBundle = {
    ...rangeBundleWithoutStudyRatio(bundle),
    quote_ratio: ratioDisplayToQuoteRatio(bundle.study_ratio),
  };
  return {
    bundle,
    chartBundle: bundle,
    ratioBundle,
  };
}
