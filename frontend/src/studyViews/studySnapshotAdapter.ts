import type { BrokerSeriesEntry, BrokerSeriesPoint, OrderbookSnapshot, RangeBundle, VolumeProfile } from '../api/types';
import type {
  ParquetStudySnapshot,
  StudyBrokerBucket,
  StudyDetailWarning,
  StudyIndicatorState,
  StudyOrderbookBucket,
  StudySnapshotBundle,
} from '../api/studyViews';
import { computeCandleVolumePocs, type TradeVolumePoc } from '../live/tradeVolumePoc';
import { bucketSeconds, type LiveMAConfig } from '../state/livePage';

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

export type StudySnapshotDetailInput = {
  orderbookByBucketStart: Map<number, StudyOrderbookBucket>;
  brokersByBucketStart: Map<number, StudyBrokerBucket>;
  detailWarnings: StudyDetailWarning[];
  volumeDistributionEnabled: boolean;
  volumeDistributionColor: string;
  volumeDistributionMaxColor: string;
  volumeDistributions: RangeBundle['volume_distributions'];
};

export type StudySnapshotRenderModel = {
  chartInput: StudySnapshotChartInput;
  details: StudySnapshotDetailInput;
  bucketMs: number;
  todayKst: string;
  restoreViewport: { rightEdgeMs: number; barSpan: number; atLiveEdge: boolean };
  paneTogglesOverride: {
    volumeEnabled: boolean;
    quoteTotalsEnabled: boolean;
    ratioEnabled: boolean;
    fillStrengthEnabled: boolean;
    programTradeEnabled: boolean;
  };
  dailyMovingAverageOverride: {
    configs: readonly LiveMAConfig[];
    masterEnabled: boolean;
    hidden: boolean;
  };
  tradeVolumePocs: TradeVolumePoc[];
  tradeVolumePocOverride: {
    enabled: boolean;
    color?: string;
    opacity?: number;
  };
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

export function studySnapshotDetails(
  snapshot: StudySnapshotBundle,
  indicatorState?: StudyIndicatorState,
): StudySnapshotDetailInput {
  return {
    orderbookByBucketStart: new Map((snapshot.orderbook_buckets ?? []).map((bucket) => [bucket.t, bucket])),
    brokersByBucketStart: new Map((snapshot.broker_buckets ?? []).map((bucket) => [bucket.t, bucket])),
    detailWarnings: snapshot.detail_warnings ?? [],
    volumeDistributionEnabled: indicatorState?.volume_distribution_enabled ?? true,
    volumeDistributionColor: indicatorState?.volume_distribution_color ?? '#64748B',
    volumeDistributionMaxColor: indicatorState?.volume_distribution_max_color ?? '#EAB308',
    volumeDistributions: snapshot.volume_distributions ?? [],
  };
}

function brokerNetAtCursor(points: readonly BrokerSeriesPoint[], cursorMs: number): number {
  let net = 0;
  for (const point of points) {
    if (point.ts_ms > cursorMs) break;
    net = point.net;
  }
  return net;
}

export function studyReferenceDetails(
  bundle: RangeBundle,
  spot?: {
    cursorMs: number | null;
    orderbook?: OrderbookSnapshot | null;
    brokers?: BrokerSeriesEntry[];
  },
): StudySnapshotDetailInput {
  const bucketStart = spot?.cursorMs == null
    ? null
    : bucketStartForCursor(bundle.candles, bundle.bucket_ms, spot.cursorMs);
  const orderbookByBucketStart = new Map<number, StudyOrderbookBucket>();
  const brokersByBucketStart = new Map<number, StudyBrokerBucket>();

  if (bucketStart != null && spot) {
    if (spot.orderbook) {
      orderbookByBucketStart.set(bucketStart, {
        t: bucketStart,
        snapshot: spot.orderbook,
        available: true,
      });
    }
    if (spot.brokers) {
      const brokers = spot.brokers
        .map((broker) => ({
          broker: broker.broker,
          net: brokerNetAtCursor(broker.points, spot.cursorMs ?? bucketStart),
          dominant_side: broker.dominant_side,
        }))
        .filter((broker) => broker.net !== 0);
      brokersByBucketStart.set(bucketStart, {
        t: bucketStart,
        brokers,
        available: brokers.length > 0,
      });
    }
  }

  return {
    orderbookByBucketStart,
    brokersByBucketStart,
    detailWarnings: [],
    volumeDistributionEnabled: true,
    volumeDistributionColor: '#64748B',
    volumeDistributionMaxColor: '#EAB308',
    volumeDistributions: bundle.volume_distributions ?? [],
  };
}

export function studyBrokerBucketsToSeries(
  brokersByBucketStart: Map<number, StudyBrokerBucket>,
  range?: { fromMs: number; toMs: number } | null,
): BrokerSeriesEntry[] {
  const byBroker = new Map<string, BrokerSeriesPoint[]>();
  const buckets = [...brokersByBucketStart.values()].sort((a, b) => a.t - b.t);

  for (const bucket of buckets) {
    if (!bucket.available) continue;
    if (range && (bucket.t < range.fromMs || bucket.t > range.toMs)) continue;
    for (const broker of bucket.brokers) {
      const points = byBroker.get(broker.broker) ?? [];
      points.push({ ts_ms: bucket.t, net: broker.net });
      byBroker.set(broker.broker, points);
    }
  }

  const series: BrokerSeriesEntry[] = [];
  for (const [broker, points] of byBroker.entries()) {
    const finalNet = points.length > 0 ? points[points.length - 1].net : 0;
    series.push({
      broker,
      final_net: finalNet,
      dominant_side: finalNet >= 0 ? 'buy' : 'sell',
      points,
    });
  }

  series.sort((a, b) => Math.abs(b.final_net) - Math.abs(a.final_net));
  return series;
}

export function bucketStartForCursor(
  candles: Array<{ ts_ms: number }>,
  bucketMs: number,
  cursorMs: number,
): number | null {
  for (const candle of candles) {
    if (candle.ts_ms <= cursorMs && cursorMs < candle.ts_ms + bucketMs) return candle.ts_ms;
  }
  return null;
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
    program_trade: snapshot.program_trade ?? { points: [] },
    volume_profile_range: EMPTY_VOLUME_PROFILE,
    volume_profile_by_day: [],
    volume_distributions: snapshot.volume_distributions ?? [],
    investorPoints: [],
    ask_peaks: snapshot.ask_peaks ?? [],
    bid_peaks: snapshot.bid_peaks ?? [],
    broker_late_entries: [],
    trade_volume_pocs: snapshot.trade_volume_pocs ?? [],
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
    program_trade: bundle.program_trade,
    volume_profile_range: bundle.volume_profile_range,
    volume_profile_by_day: bundle.volume_profile_by_day,
    volume_distributions: bundle.volume_distributions,
    investorPoints: bundle.investorPoints,
    ask_peaks: bundle.ask_peaks,
    bid_peaks: bundle.bid_peaks,
    broker_late_entries: bundle.broker_late_entries,
    trade_volume_pocs: bundle.trade_volume_pocs,
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

export function studySnapshotRenderModel(snapshot: ParquetStudySnapshot): StudySnapshotRenderModel {
  const chartInput = studySnapshotBundleToChartInput(snapshot.bundle);
  const savedPocs = (snapshot.bundle.trade_volume_pocs ?? []).map((poc) => ({
    date: poc.date,
    centerPrice: poc.center_price,
    lowPrice: poc.low_price,
    highPrice: poc.high_price,
    qty: poc.qty,
    t_ms: poc.t_ms,
    bandPct: poc.band_pct,
  }));
  const seenDates = new Set(savedPocs.map((poc) => poc.date));
  const fallbackPocs = computeCandleVolumePocs(
    chartInput.bundle.candles,
    chartInput.bundle.segments,
    { bandPct: snapshot.indicator_state.trade_volume_poc_band_pct ?? 0.005 },
  ).filter((poc) => !seenDates.has(poc.date));

  return {
    chartInput,
    details: studySnapshotDetails(snapshot.bundle, snapshot.indicator_state),
    bucketMs: (bucketSeconds(snapshot.timeframe) ?? 60) * 1000,
    todayKst: snapshot.bundle.segments.at(-1)?.date ?? '',
    restoreViewport: {
      rightEdgeMs: snapshot.viewport.right_edge_ms,
      barSpan: snapshot.viewport.bar_span,
      atLiveEdge: snapshot.viewport.at_live_edge,
    },
    paneTogglesOverride: {
      volumeEnabled: snapshot.indicator_state.volume_enabled,
      quoteTotalsEnabled: snapshot.indicator_state.quote_totals_enabled,
      ratioEnabled: snapshot.indicator_state.ratio_enabled,
      fillStrengthEnabled: snapshot.indicator_state.fill_strength_enabled,
      programTradeEnabled: snapshot.indicator_state.program_trade_enabled ?? true,
    },
    dailyMovingAverageOverride: {
      configs: (snapshot.indicator_state.daily_moving_averages ?? []).map((m): LiveMAConfig => ({
        id: m.id,
        enabled: m.enabled,
        period: m.period,
        color: m.color,
        lineWidth: m.line_width,
        source: m.source,
      })),
      masterEnabled: snapshot.indicator_state.daily_moving_average_enabled === true,
      hidden: snapshot.indicator_state.daily_moving_average_hidden === true,
    },
    tradeVolumePocs: [...savedPocs, ...fallbackPocs],
    tradeVolumePocOverride: {
      enabled: snapshot.indicator_state.trade_volume_poc_enabled !== false,
      color: snapshot.indicator_state.trade_volume_poc_color,
      opacity: snapshot.indicator_state.trade_volume_poc_opacity,
    },
  };
}
