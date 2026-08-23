import { memo, useEffect, useMemo, useRef } from 'react';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import type { BidPeak, Candle, RangeSegment } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useActivePrefs } from '../state/chartPrefs';
import {
  registerFlagLegendValues,
  unregisterFlagLegendValues,
  type FlagLegendValueProvider,
} from './indicators/flagLegendValueRegistry';
import {
  buildPeakWallOverlaySegments,
  preparePeakWallSegmentsForRender,
  toPeakRankLimit,
} from './peakWallSegments';
import { PEAK_WALL_LEGEND_RANK_LIMIT, peakWallRankLegendCells } from './peakWallVisibleRanking';
import { candleExtremesByVirtualSec, peakWallRankArrowsFromSegments } from './peakWallRankArrows';
import { PeakWallRankArrowsPrimitive } from '../chart/PeakWallRankArrowsPrimitive';
import type { VisibleTimeCutoff } from './peakWallVisibleCutoff';
import { usePeakMaFilter } from './peakWallMaFilter';
import type { PeakDailyMaFilter } from './peakWallDailyMaFilter';
import {
  AskPeakSegmentsPrimitive,
  type PeakWallSegment,
} from '../chart/AskPeakSegmentsPrimitive';
import { useWindowIndicator, useWindowScopeId } from './workspace/windowView';

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  /** LivePage의 useDayBidPeaks 결과 — 거래일별 매수 최대벽. */
  dayBidPeaks: readonly BidPeak[];
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  /** 오늘(KST YYYYMMDD) — 이 날 세그먼트만 라이브 엣지까지 연장·점 표시. */
  todayKst: string;
  visibleTimeCutoff?: VisibleTimeCutoff | null;
  /** 일봉 MA 필터 — `LiveChartRoot` 가 한 번 계산해 내려보낸다(매도쪽과 동일). */
  dailyMaFilter?: PeakDailyMaFilter | null;
};

/** 거래일별 매수 최대벽 오버레이. candle series에 커스텀 primitive를 걸어 각 날의 수평 세그먼트를
 *  그린다(풀-너비 price line이 아니라 그날 구간만 → 여러 날 동시 표시). 색·두께·on/off는 스토어.
 *  형제: LiveCurrentPriceLine(현재가 풀-너비 점선). */
function LiveBidPeakSegments({ paneSeries, axis, dayBidPeaks, segments, candles, todayKst, visibleTimeCutoff = null, dailyMaFilter = null }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useWindowIndicator((s) => s.bidPeakEnabled);
  const hidden = useWindowIndicator((s) => s.bidPeakHidden);
  const color = useWindowIndicator((s) => s.bidPeakColor);
  const lineWidth = useWindowIndicator((s) => s.bidPeakLineWidth);
  const intraMax = useActivePrefs((s) => s.bidPeakIntraMax);
  const allPriceRankLimit = useActivePrefs((s) => s.bidPeakAllPriceRankLimit);
  const rankArrowEnabled = useActivePrefs((s) => s.bidPeakRankArrowEnabled);
  const maFilter = usePeakMaFilter('bid');
  const primRef = useRef<AskPeakSegmentsPrimitive | null>(null);
  /** 레전드가 랭킹할 세그먼트(필터 통과 후) — 사유는 ask 쪽 동명 ref 주석 참조. */
  const legendSegmentsRef = useRef<readonly PeakWallSegment[]>([]);
  const arrowPrimRef = useRef<PeakWallRankArrowsPrimitive | null>(null);
  /** 가상초 → 봉 극값(ask 쪽과 동일 규칙). 매수는 **저가**를 앵커로 쓴다. */
  const candleExtremes = useMemo(
    () => candleExtremesByVirtualSec(candles, axis),
    [candles, axis],
  );
  // 레전드 값 provider 의 창 스코프(멀티창) — ask 쪽과 동일 규칙.
  const windowId = useWindowScopeId();

  // 생성: series 핸들당 1회(LiveCurrentPriceLine과 동일 — tf·종목 전환에도 핸들 유지).
  useEffect(() => {
    if (!series) return;
    const prim = new AskPeakSegmentsPrimitive();
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

  // 순위 화살표 primitive(ask 미러) — 앵커가 캔들 저가라 세그먼트 렌더러와 별개다.
  useEffect(() => {
    if (!series) return;
    const prim = new PeakWallRankArrowsPrimitive();
    series.attachPrimitive(prim);
    arrowPrimRef.current = prim;
    return () => {
      try {
        series.detachPrimitive(prim);
      } catch {
        /* chart already torn down */
      }
      arrowPrimRef.current = null;
    };
  }, [series]);

  // 레전드 값 provider — **보이는 영역**의 잔량 상위 3개(ask 쪽과 동일 규칙: 호출 시점에
  // 범위를 읽고, hidden 과 무관하게 값을 유지한다).
  useEffect(() => {
    const provider: FlagLegendValueProvider = () => peakWallRankLegendCells(
      legendSegmentsRef.current,
      primRef.current?.chartApi()?.timeScale().getVisibleRange() ?? null,
      'bid-peak',
    );
    registerFlagLegendValues(windowId, 'bid-peak', provider);
    return () => unregisterFlagLegendValues(windowId, 'bid-peak', provider);
  }, [windowId]);

  // 갱신: dayBidPeaks·segments·candles·축·스타일·토글 변화 시 세그먼트 재계산.
  useEffect(() => {
    const prim = primRef.current;
    if (!prim) return;
    const baselineRankLimit = toPeakRankLimit(allPriceRankLimit);
    const nextSegments = enabled
      ? buildPeakWallOverlaySegments({
        peaks: dayBidPeaks,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color, lineWidth },
        intraMax,
        allPriceRankLimit: baselineRankLimit,
        visibleTimeCutoff,
        maFilter,
        dailyMaFilter,
      })
      : [];
    // 레전드는 눈(hidden)과 무관하게 값을 유지 → 그리기 게이트보다 먼저 채운다(ask 미러).
    legendSegmentsRef.current = nextSegments;
    // 화살표는 그리기이므로 눈이 지운다. 랭킹은 primitive 가 draw 시점에 한다.
    arrowPrimRef.current?.setArrows(
      hidden || !rankArrowEnabled
        ? []
        : peakWallRankArrowsFromSegments(nextSegments, 'bid', candleExtremes),
      PEAK_WALL_LEGEND_RANK_LIMIT,
    );
    prim.setSegments(hidden ? [] : preparePeakWallSegmentsForRender(nextSegments));
  }, [
    dayBidPeaks,
    segments,
    candles,
    axis,
    todayKst,
    color,
    lineWidth,
    enabled,
    hidden,
    intraMax,
    allPriceRankLimit,
    visibleTimeCutoff,
    maFilter,
    dailyMaFilter,
    series,
    rankArrowEnabled,
    candleExtremes,
  ]);

  return null;
}

export default memo(LiveBidPeakSegments);
