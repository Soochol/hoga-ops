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
import { useActivePrefs } from '../state/chartPrefs';
import { buildPeakWallOverlaySegments, toPeakRankLimit } from './peakWallSegments';
import type { VisibleTimeCutoff } from './peakWallVisibleCutoff';
import { usePeakMaFilter } from './peakWallMaFilter';
import type { PeakDailyMaFilter } from './peakWallDailyMaFilter';
import { useWindowIndicator } from './workspace/windowView';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  dayAskPeaks: readonly AskPeak[];
  dayBidPeaks: readonly BidPeak[];
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  todayKst: string;
  askVisibleTimeCutoff?: VisibleTimeCutoff | null;
  bidVisibleTimeCutoff?: VisibleTimeCutoff | null;
  /** 일봉 MA 필터 — 선(LiveAsk/BidPeakSegments)과 **같은 값**을 받아야 라벨만 남는 유령이
   *  생기지 않는다. `LiveChartRoot` 가 한 번 계산해 셋 모두에 같은 참조를 내려보낸다. */
  askDailyMaFilter?: PeakDailyMaFilter | null;
  bidDailyMaFilter?: PeakDailyMaFilter | null;
};


function LivePeakWallDockedLabels({
  paneSeries,
  axis,
  dayAskPeaks,
  dayBidPeaks,
  segments,
  candles,
  todayKst,
  askVisibleTimeCutoff = null,
  bidVisibleTimeCutoff = null,
  askDailyMaFilter = null,
  bidDailyMaFilter = null,
}: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  // 눈(hidden)은 세그먼트와 도킹 라벨을 함께 숨긴다 — 시각 요소 일괄.
  const askPeakEnabled = useWindowIndicator((s) => s.askPeakEnabled && !s.askPeakHidden);
  const bidPeakEnabled = useWindowIndicator((s) => s.bidPeakEnabled && !s.bidPeakHidden);
  const askColor = useWindowIndicator((s) => s.askPeakColor);
  const askLineWidth = useWindowIndicator((s) => s.askPeakLineWidth);
  const bidColor = useWindowIndicator((s) => s.bidPeakColor);
  const bidLineWidth = useWindowIndicator((s) => s.bidPeakLineWidth);
  const askIntraMax = useActivePrefs((s) => s.askPeakIntraMax);
  const askLabelEnabled = useActivePrefs((s) => s.askPeakLabelEnabled);
  const askAllPriceRankLimit = useActivePrefs((s) => s.askPeakAllPriceRankLimit);
  const bidIntraMax = useActivePrefs((s) => s.bidPeakIntraMax);
  const bidLabelEnabled = useActivePrefs((s) => s.bidPeakLabelEnabled);
  const bidAllPriceRankLimit = useActivePrefs((s) => s.bidPeakAllPriceRankLimit);
  // 선(LiveAskPeakSegments/LiveBidPeakSegments)과 같은 필터 — 라벨만 남는 유령을 막는다.
  const askMaFilter = usePeakMaFilter('ask');
  const bidMaFilter = usePeakMaFilter('bid');
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
    const askPeakRankLimit = toPeakRankLimit(askAllPriceRankLimit);
    const askRaw = askPeakEnabled && askLabelEnabled
      ? buildPeakWallOverlaySegments({
        peaks: dayAskPeaks,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color: askColor, lineWidth: askLineWidth },
        intraMax: askIntraMax,
        allPriceRankLimit: askPeakRankLimit,
        visibleTimeCutoff: askVisibleTimeCutoff,
        maFilter: askMaFilter,
        dailyMaFilter: askDailyMaFilter,
      })
      : [];
    const timeScale = prim.chartApi()?.timeScale();
    const visibleRange = timeScale?.getVisibleRange() ?? null;
    // 줌 예산: barSpacing 이 좁으면(줌아웃) 0 → 라벨 전부 숨김. 넓으면 side별 qty 상위 N 만.
    const labelBudget = peakLabelBudgetForBarSpacing(timeScale?.options?.().barSpacing ?? 0);
    const bidSegments = bidPeakEnabled && bidLabelEnabled
      ? buildPeakWallOverlaySegments({
        peaks: dayBidPeaks,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color: bidColor, lineWidth: bidLineWidth },
        intraMax: bidIntraMax,
        allPriceRankLimit: toPeakRankLimit(bidAllPriceRankLimit),
        visibleTimeCutoff: bidVisibleTimeCutoff,
        maFilter: bidMaFilter,
        dailyMaFilter: bidDailyMaFilter,
      })
      : [];
    // side 는 라벨의 세로 방향을 가른다 — 매도는 선 위, 매수는 선 아래. 같은 분봉에
    // 양쪽 벽이 동시에 잡히는 최빈 겹침이 배치 없이 해소된다.
    prim.setLabels([
      ...livePeakWallDockedLabelsFromSegments(askRaw, 'ask', visibleRange, labelBudget),
      ...livePeakWallDockedLabelsFromSegments(bidSegments, 'bid', visibleRange, labelBudget),
    ]);
  }, [
    askAllPriceRankLimit,
    askColor,
    askDailyMaFilter,
    askIntraMax,
    askLabelEnabled,
    askLineWidth,
    askMaFilter,
    askPeakEnabled,
    askVisibleTimeCutoff,
    axis,
    bidAllPriceRankLimit,
    bidColor,
    bidDailyMaFilter,
    bidIntraMax,
    bidLabelEnabled,
    bidLineWidth,
    bidMaFilter,
    bidPeakEnabled,
    bidVisibleTimeCutoff,
    candles,
    dayAskPeaks,
    dayBidPeaks,
    segments,
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
      safeUnsubscribe(() => timeScale.unsubscribeVisibleLogicalRangeChange(handler));
    };
  }, [series, updateLabels]);

  return null;
}

export default memo(LivePeakWallDockedLabels);
