import type { StudyIndicatorState, StudySavedFromRoute, StudySnapshotBundle } from '../api/studyViews';
import type { QuoteRatioPoint, RangeBundle } from '../api/types';
import { quoteImbalance } from '../util/imbalance';
import type { StudySnapshotRangeBundle } from './studySnapshotAdapter';

export type ProjectStudySnapshotHogaArgs = {
  route: StudySavedFromRoute;
  bundle: RangeBundle;
  indicatorState: StudyIndicatorState;
  segments: RangeBundle['segments'];
  from: number;
  to: number;
};

export type ProjectedStudySnapshotHoga = Pick<StudySnapshotBundle, 'quote_totals' | 'ratio' | 'fill_strength'>;

function hasStudyRatio(bundle: RangeBundle): bundle is StudySnapshotRangeBundle {
  const studyRatio = (bundle as Partial<StudySnapshotRangeBundle>).study_ratio;
  return Array.isArray(studyRatio?.points);
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

export function projectStudySnapshotHoga(args: ProjectStudySnapshotHogaArgs): ProjectedStudySnapshotHoga {
  const within = (t: number) => t >= args.from && t <= args.to;
  const hideAt = (t: number) => isAuctionHidden(
    args.segments,
    args.indicatorState.auction_window_mask,
    t,
  );
  const sourceStudyRatio = args.route === '/study' && hasStudyRatio(args.bundle)
    ? args.bundle.study_ratio.points
    : null;

  return {
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
  };
}
