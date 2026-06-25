import type { RangeBundle, QuoteRatioPoint } from '../../api/types';
import { withHogaGapSentinels } from '../util/hogaGapHide';

export const quoteRatioPointsForBundle = (bundle: RangeBundle): readonly QuoteRatioPoint[] =>
  withHogaGapSentinels(bundle.quote_ratio.points, bundle.candles ?? [], bundle.bucket_ms);

export const quoteRatioPointsForSlice = ({
  bundle,
  points,
  allPoints,
  fromT,
  toT,
}: {
  bundle: RangeBundle;
  points: readonly QuoteRatioPoint[];
  allPoints: readonly QuoteRatioPoint[];
  fromT?: number;
  toT?: number;
}): readonly QuoteRatioPoint[] =>
  withHogaGapSentinels(points, bundle.candles ?? [], bundle.bucket_ms, {
    firstHogaT: allPoints[0]?.t,
    lastHogaT: allPoints[allPoints.length - 1]?.t,
    fromT,
    toT,
  });
