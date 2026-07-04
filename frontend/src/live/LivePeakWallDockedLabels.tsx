import { memo, useCallback, useEffect, useRef } from 'react';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import type { AskPeak, BidPeak, Candle, RangeSegment } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { livePeakWallDockedLabelsFromSegments } from '../chart/AskPeakSegmentsPrimitive';
import { PeakWallDockedLabelsPrimitive } from '../chart/PeakWallDockedLabelsPrimitive';
import { useLivePageStore } from '../state/livePage';
import { useActivePrefs } from '../state/chartPrefs';
import { buildAskPeakOverlaySegments, styleVisibleMaxAskPeakSegments } from './LiveAskPeakSegments';
import { buildBidPeakOverlaySegments } from './LiveBidPeakSegments';
import type { VisibleTimeCutoff } from './peakWallVisibleCutoff';

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
  const askPeakEnabled = useLivePageStore((s) => s.askPeakEnabled);
  const bidPeakEnabled = useLivePageStore((s) => s.bidPeakEnabled);
  const askColor = useLivePageStore((s) => s.askPeakColor);
  const askLineWidth = useLivePageStore((s) => s.askPeakLineWidth);
  const askAllPriceColor = useLivePageStore((s) => s.askPeakAllPriceColor);
  const askAllPriceLineWidth = useLivePageStore((s) => s.askPeakAllPriceLineWidth);
  const askVisibleMaxColor = useLivePageStore((s) => s.askPeakVisibleMaxColor);
  const askVisibleMaxLineWidth = useLivePageStore((s) => s.askPeakVisibleMaxLineWidth);
  const bidColor = useLivePageStore((s) => s.bidPeakColor);
  const bidLineWidth = useLivePageStore((s) => s.bidPeakLineWidth);
  const bidAllPriceColor = useLivePageStore((s) => s.bidPeakAllPriceColor);
  const bidAllPriceLineWidth = useLivePageStore((s) => s.bidPeakAllPriceLineWidth);
  const askIntraMax = useActivePrefs((s) => s.askPeakIntraMax);
  const askShowAllPrices = useActivePrefs((s) => s.askPeakShowAllPrices);
  const askAllPriceRankLimit = useActivePrefs((s) => s.askPeakAllPriceRankLimit);
  const askVisibleMaxRankLimit = useActivePrefs((s) => s.askPeakVisibleMaxRankLimit);
  const bidIntraMax = useActivePrefs((s) => s.bidPeakIntraMax);
  const bidShowAllPrices = useActivePrefs((s) => s.bidPeakShowAllPrices);
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
    const askRaw = askPeakEnabled
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
        allPriceRankLimit: askAllPriceRankLimit as 1 | 2 | 3,
        visibleTimeCutoff: askVisibleTimeCutoff,
      })
      : [];
    const visibleRange = prim.chartApi()?.timeScale().getVisibleRange() ?? null;
    const askStyled = styleVisibleMaxAskPeakSegments(
      askRaw,
      visibleRange,
      { color: askVisibleMaxColor, lineWidth: askVisibleMaxLineWidth },
      askVisibleMaxRankLimit as 1 | 2 | 3,
    );
    const bidSegments = bidPeakEnabled
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
        visibleTimeCutoff: bidVisibleTimeCutoff,
      })
      : [];
    prim.setLabels([
      ...livePeakWallDockedLabelsFromSegments(askStyled, visibleRange),
      ...livePeakWallDockedLabelsFromSegments(bidSegments, visibleRange),
    ]);
  }, [
    askAllPriceColor,
    askAllPriceLineWidth,
    askAllPriceRankLimit,
    askColor,
    askIntraMax,
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
    bidColor,
    bidIntraMax,
    bidLineWidth,
    bidPeakEnabled,
    bidShowAllPrices,
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
