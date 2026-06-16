import type { RangeBundle, QuoteRatioPoint } from '../api/types';
import type { LiveTimeframe } from '../state/livePage';
import type {
  ParquetStudyViewWriteRequest,
  StudyDataProvenance,
  StudyIndicatorState,
  StudyProvenance,
  StudySavedFromRoute,
  StudyViewport,
} from '../api/studyViews';
import { quoteImbalance } from '../util/imbalance';
import type { StudySnapshotRangeBundle } from './studySnapshotAdapter';

export type BuildStudySnapshotArgs = {
  name: string;
  memo?: string;
  tags?: string[];
  route: StudySavedFromRoute;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  viewport: StudyViewport;
  indicatorState: StudyIndicatorState;
  bundle: RangeBundle;
  fromIndex: number;
  toIndex: number;
  capturedAtMs?: number;
};

function hasStudyRatio(bundle: RangeBundle): bundle is StudySnapshotRangeBundle {
  const studyRatio = (bundle as Partial<StudySnapshotRangeBundle>).study_ratio;
  return Array.isArray(studyRatio?.points);
}

function dataWarnings(bundle: RangeBundle): string[] {
  const warnings = (bundle as RangeBundle & { data_warnings?: unknown }).data_warnings;
  return Array.isArray(warnings) ? warnings.filter((w): w is string => typeof w === 'string') : [];
}

function isAuctionHidden(
  segments: RangeBundle['segments'],
  mask: boolean,
  t: number,
): boolean {
  if (!mask) return false;
  const TEN_MINUTES_MS = 10 * 60 * 1000;
  return segments.some((s) => (
    t >= s.session_close_ms - TEN_MINUTES_MS && t <= s.session_close_ms
  ));
}

function ratioValue(
  p: QuoteRatioPoint,
  indicatorState: StudyIndicatorState,
): number {
  const raw = indicatorState.aggregation_basis === 'intra_period_max'
    ? quoteImbalance(p.imb_max_bid, p.imb_max_ask)
    : quoteImbalance(p.bid_total, p.ask_total);
  return indicatorState.ratio_outlier_filter_enabled
    && 1 + Math.abs(raw) >= indicatorState.ratio_outlier_threshold
    ? 0
    : raw;
}

export function buildStudySnapshotRequest(args: BuildStudySnapshotArgs): ParquetStudyViewWriteRequest {
  const fromIndex = Math.max(0, Math.min(args.fromIndex, args.bundle.candles.length - 1));
  const toIndex = Math.max(fromIndex, Math.min(args.toIndex, args.bundle.candles.length - 1));
  const candles = args.bundle.candles.slice(fromIndex, toIndex + 1);
  const from = candles[0]?.ts_ms ?? args.viewport.right_edge_ms;
  const to = candles[candles.length - 1]?.ts_ms ?? args.viewport.right_edge_ms;
  const within = (t: number) => t >= from && t <= to;
  const dataProvenance: StudyDataProvenance = args.route === '/study' ? 'study_snapshot' : 'live_mixed';
  const provenance: StudyProvenance = {
    saved_from_route: args.route,
    data_provenance: dataProvenance,
  };

  const segments = args.bundle.segments.filter((s) => s.session_close_ms >= from && s.session_open_ms <= to);
  const hideAt = (t: number) => isAuctionHidden(segments, args.indicatorState.auction_window_mask, t);
  const sourceStudyRatio = args.route === '/study' && hasStudyRatio(args.bundle)
    ? args.bundle.study_ratio.points
    : null;

  const snapshot = {
    schema_version: 1 as const,
    code: args.code,
    label: args.label,
    timeframe: args.timeframe,
    snapshot_from_ms: from,
    snapshot_to_ms: to,
    bucket_kind: args.timeframe,
    viewport: args.viewport,
    indicator_state: args.indicatorState,
    provenance,
    bundle: {
      code: args.code,
      timeframe: args.timeframe,
      snapshot_from_ms: from,
      snapshot_to_ms: to,
      segments,
      candles: candles.map((c) => ({
        t: c.ts_ms,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.vol_a + c.vol_b,
      })),
      quote_totals: args.bundle.quote_ratio.points
        .filter((p) => within(p.t))
        .map((p) => (
          args.indicatorState.quote_totals_enabled && !hideAt(p.t)
            ? { t: p.t, bid_total: p.bid_total, ask_total: p.ask_total, visible: true }
            : { t: p.t, visible: false }
        )),
      ratio: sourceStudyRatio
        ? sourceStudyRatio
          .filter((p) => within(p.t))
          .map((p) => (
            args.indicatorState.ratio_enabled && !hideAt(p.t)
              ? { t: p.t, value: p.value, visible: true }
              : { t: p.t, visible: false }
          ))
        : args.bundle.quote_ratio.points
          .filter((p) => within(p.t))
          .map((p) => (
            args.indicatorState.ratio_enabled && !hideAt(p.t)
              ? { t: p.t, value: ratioValue(p, args.indicatorState), visible: true }
              : { t: p.t, visible: false }
          )),
      fill_strength: args.bundle.fill_strength.points
        .filter((p) => within(p.t))
        .map((p) => (
          args.indicatorState.fill_strength_enabled && !hideAt(p.t)
            ? { t: p.t, buy_qty: p.buy_qty, sell_qty: p.sell_qty, visible: true }
            : { t: p.t, visible: false }
        )),
      data_warnings: dataWarnings(args.bundle),
    },
    captured_at_ms: args.capturedAtMs ?? Date.now(),
  };

  return {
    name: args.name,
    code: args.code,
    label: args.label,
    timeframe: args.timeframe,
    snapshot_from_ms: from,
    snapshot_to_ms: to,
    viewport: args.viewport,
    indicator_state: args.indicatorState,
    snapshot,
    provenance,
    memo: args.memo ?? '',
    tags: args.tags ?? [],
  };
}
