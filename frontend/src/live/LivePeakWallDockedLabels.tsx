import { memo, useCallback, useEffect, useRef } from 'react';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import type { AskPeak, BidPeak, Candle, RangeSegment } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import {
  livePeakWallDockedLabelsFromSegments,
  peakLabelBudgetForBarSpacing,
} from '../chart/AskPeakSegmentsPrimitive';
import { PeakWallDockedLabelsPrimitive } from '../chart/PeakWallDockedLabelsPrimitive';
import { useActivePrefs, type ChartViewPrefs } from '../state/chartPrefs';
import { buildAskPeakOverlaySegments, styleVisibleMaxAskPeakSegments } from './LiveAskPeakSegments';
import { buildBidPeakOverlaySegments } from './LiveBidPeakSegments';
import type { VisibleTimeCutoff } from './peakWallVisibleCutoff';
import { useWindowIndicator } from './workspace/windowView';

type VisibleMaxRankLimit = 0 | 1 | 2 | 3;

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  dayAskPeaks: readonly AskPeak[];
  todayAllPriceAskPeak?: AskPeak | null;
  dayBidPeaks: readonly BidPeak[];
  todayAllPriceBidPeak?: BidPeak | null;
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  todayKst: string;
  askVisibleTimeCutoff?: VisibleTimeCutoff | null;
  bidVisibleTimeCutoff?: VisibleTimeCutoff | null;
};

function toPeakRankLimit(value: number): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

function toVisibleMaxRankLimit(value: number): VisibleMaxRankLimit {
  return value === 0 || value === 2 || value === 3 ? value : 1;
}

function maxPeakRankLimit(a: number, b: number): 1 | 2 | 3 {
  return Math.max(toPeakRankLimit(a), toVisibleMaxRankLimit(b)) as 1 | 2 | 3;
}

function optionalRankLimit(
  prefs: ChartViewPrefs,
  key: 'askPeakUntradedRankLimit' | 'bidPeakUntradedRankLimit',
): 1 | 2 | 3 {
  const value = (prefs as ChartViewPrefs & Partial<Record<typeof key, number>>)[key];
  return value === 2 || value === 3 ? value : 1;
}

function LivePeakWallDockedLabels({
  paneSeries,
  axis,
  dayAskPeaks,
  todayAllPriceAskPeak = null,
  dayBidPeaks,
  todayAllPriceBidPeak = null,
  segments,
  candles,
  todayKst,
  askVisibleTimeCutoff = null,
  bidVisibleTimeCutoff = null,
}: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  // 눈(hidden)은 세그먼트와 도킹 라벨을 함께 숨긴다 — 시각 요소 일괄.
  const askPeakEnabled = useWindowIndicator((s) => s.askPeakEnabled && !s.askPeakHidden);
  const bidPeakEnabled = useWindowIndicator((s) => s.bidPeakEnabled && !s.bidPeakHidden);
  const askColor = useWindowIndicator((s) => s.askPeakColor);
  const askLineWidth = useWindowIndicator((s) => s.askPeakLineWidth);
  const askAllPriceColor = useWindowIndicator((s) => s.askPeakAllPriceColor);
  const askAllPriceLineWidth = useWindowIndicator((s) => s.askPeakAllPriceLineWidth);
  const askVisibleMaxColor = useWindowIndicator((s) => s.askPeakVisibleMaxColor);
  const askVisibleMaxLineWidth = useWindowIndicator((s) => s.askPeakVisibleMaxLineWidth);
  const bidColor = useWindowIndicator((s) => s.bidPeakColor);
  const bidLineWidth = useWindowIndicator((s) => s.bidPeakLineWidth);
  const bidAllPriceColor = useWindowIndicator((s) => s.bidPeakAllPriceColor);
  const bidAllPriceLineWidth = useWindowIndicator((s) => s.bidPeakAllPriceLineWidth);
  const askIntraMax = useActivePrefs((s) => s.askPeakIntraMax);
  const askShowAllPrices = useActivePrefs((s) => s.askPeakShowAllPrices);
  const askLabelEnabled = useActivePrefs((s) => s.askPeakLabelEnabled);
  const askAllPriceRankLimit = useActivePrefs((s) => s.askPeakAllPriceRankLimit);
  const askUntradedRankLimit = useActivePrefs((s) => optionalRankLimit(s, 'askPeakUntradedRankLimit'));
  const askVisibleMaxRankLimit = useActivePrefs((s) => s.askPeakVisibleMaxRankLimit);
  const bidIntraMax = useActivePrefs((s) => s.bidPeakIntraMax);
  const bidShowAllPrices = useActivePrefs((s) => s.bidPeakShowAllPrices);
  const bidLabelEnabled = useActivePrefs((s) => s.bidPeakLabelEnabled);
  const bidAllPriceRankLimit = useActivePrefs((s) => s.bidPeakAllPriceRankLimit);
  const bidUntradedRankLimit = useActivePrefs((s) => optionalRankLimit(s, 'bidPeakUntradedRankLimit'));
  const bidVisibleMaxRankLimit = useActivePrefs((s) => s.bidPeakVisibleMaxRankLimit);
  const primRef = useRef<PeakWallDockedLabelsPrimitive | null>(null);

  useEffect(() => {
    if (!series) return;
    const prim = new PeakWallDockedLabelsPrimitive();
    series.attachPrimitive(prim);
    primRef.current = prim;
    return () => {
      try {
        series.detachPrimitive(prim);
      } catch {
        /* chart already torn down */
      }
      primRef.current = null;
    };
  }, [series]);

  const updateLabels = useCallback(() => {
    const prim = primRef.current;
    if (!prim) return;
    const askPeakRankLimit = maxPeakRankLimit(askAllPriceRankLimit, askVisibleMaxRankLimit);
    const askRaw = askPeakEnabled && askLabelEnabled
      ? buildAskPeakOverlaySegments({
        dayAskPeaks,
        todayAllPriceAskPeak,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color: askColor, lineWidth: askLineWidth },
        allPriceStyle: { color: askAllPriceColor, lineWidth: askAllPriceLineWidth },
        intraMax: askIntraMax,
        showAllPrices: askShowAllPrices,
        allPriceRankLimit: askPeakRankLimit,
        untradedRankLimit: askUntradedRankLimit,
        visibleTimeCutoff: askVisibleTimeCutoff,
      })
      : [];
    const timeScale = prim.chartApi()?.timeScale();
    const visibleRange = timeScale?.getVisibleRange() ?? null;
    // 줌 예산: barSpacing 이 좁으면(줌아웃) 0 → 라벨 전부 숨김. 넓으면 side별 qty 상위 N 만.
    const labelBudget = peakLabelBudgetForBarSpacing(timeScale?.options?.().barSpacing ?? 0);
    const askStyled = styleVisibleMaxAskPeakSegments(
      askRaw,
      visibleRange,
      { color: askVisibleMaxColor, lineWidth: askVisibleMaxLineWidth },
      toVisibleMaxRankLimit(askVisibleMaxRankLimit),
    );
    const bidSegments = bidPeakEnabled && bidLabelEnabled
      ? buildBidPeakOverlaySegments({
        dayBidPeaks,
        todayAllPriceBidPeak,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color: bidColor, lineWidth: bidLineWidth },
        allPriceStyle: { color: bidAllPriceColor, lineWidth: bidAllPriceLineWidth },
        intraMax: bidIntraMax,
        showAllPrices: bidShowAllPrices,
        allPriceRankLimit: maxPeakRankLimit(bidAllPriceRankLimit, bidVisibleMaxRankLimit),
        untradedRankLimit: bidUntradedRankLimit,
        visibleTimeCutoff: bidVisibleTimeCutoff,
      })
      : [];
    prim.setLabels([
      ...livePeakWallDockedLabelsFromSegments(askStyled, visibleRange, labelBudget),
      ...livePeakWallDockedLabelsFromSegments(bidSegments, visibleRange, labelBudget),
    ]);
  }, [
    askAllPriceColor,
    askAllPriceLineWidth,
    askAllPriceRankLimit,
    askUntradedRankLimit,
    askColor,
    askIntraMax,
    askLabelEnabled,
    askLineWidth,
    askPeakEnabled,
    askShowAllPrices,
    askVisibleMaxColor,
    askVisibleMaxLineWidth,
    askVisibleMaxRankLimit,
    askVisibleTimeCutoff,
    axis,
    bidAllPriceColor,
    bidAllPriceLineWidth,
    bidAllPriceRankLimit,
    bidUntradedRankLimit,
    bidColor,
    bidIntraMax,
    bidLabelEnabled,
    bidLineWidth,
    bidPeakEnabled,
    bidShowAllPrices,
    bidVisibleMaxRankLimit,
    bidVisibleTimeCutoff,
    candles,
    dayAskPeaks,
    dayBidPeaks,
    segments,
    todayAllPriceAskPeak,
    todayAllPriceBidPeak,
    todayKst,
  ]);

  useEffect(() => {
    updateLabels();
  }, [updateLabels, series]);

  useEffect(() => {
    const prim = primRef.current;
    const chart = prim?.chartApi();
    if (!chart) return;
    const timeScale = chart.timeScale();
    const handler = () => updateLabels();
    timeScale.subscribeVisibleLogicalRangeChange(handler);
    updateLabels();
    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [series, updateLabels]);

  return null;
}

export default memo(LivePeakWallDockedLabels);
