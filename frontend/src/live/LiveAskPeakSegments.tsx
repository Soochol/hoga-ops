import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import type { AskPeak, Candle, RangeSegment } from '../api/types';
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
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  /** LivePage의 useDayAskPeaks 결과 — 거래일별 매도 최대벽. */
  dayAskPeaks: readonly AskPeak[];
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  /** 오늘(KST YYYYMMDD) — 이 날 세그먼트만 라이브 엣지까지 연장·점 표시. */
  todayKst: string;
  visibleTimeCutoff?: VisibleTimeCutoff | null;
  /** 일봉 MA 필터 — 데이터 fetch 가 걸린 훅이라 `LiveChartRoot` 가 한 번 계산해 내려보낸다. */
  dailyMaFilter?: PeakDailyMaFilter | null;
};

/** 거래일별 매도 최대벽 오버레이. candle series에 커스텀 primitive를 걸어 각 날의 수평 세그먼트를
 *  그린다(풀-너비 price line이 아니라 그날 구간만 → 여러 날 동시 표시). 색·두께·on/off는 스토어.
 *  형제: LiveCurrentPriceLine(현재가 풀-너비 점선). */
function LiveAskPeakSegments({ paneSeries, axis, dayAskPeaks, segments, candles, todayKst, visibleTimeCutoff = null, dailyMaFilter = null }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useWindowIndicator((s) => s.askPeakEnabled);
  const hidden = useWindowIndicator((s) => s.askPeakHidden);
  const color = useWindowIndicator((s) => s.askPeakColor);
  const lineWidth = useWindowIndicator((s) => s.askPeakLineWidth);
  const intraMax = useActivePrefs((s) => s.askPeakIntraMax);
  const allPriceRankLimit = useActivePrefs((s) => s.askPeakAllPriceRankLimit);
  const rankArrowEnabled = useActivePrefs((s) => s.askPeakRankArrowEnabled);
  const maFilter = usePeakMaFilter('ask');
  const primRef = useRef<AskPeakSegmentsPrimitive | null>(null);
  /** 레전드가 랭킹할 세그먼트 — `updateSegments` 가 **필터를 모두 통과한 뒤**의 집합을
   *  여기 넣는다. provider 가 이 ref 를 읽으므로 레전드는 화면에 실제로 그려진(그려질)
   *  벽만 이름 부른다. ref 인 이유: provider 는 비반응형 레지스트리에 등록되고 레전드
   *  렌더 시점에 lazy 하게 불리므로, 스토어/props 를 provider effect 의 deps 로 끌어오면
   *  등록·해제만 반복된다. */
  const legendSegmentsRef = useRef<readonly PeakWallSegment[]>([]);
  const arrowPrimRef = useRef<PeakWallRankArrowsPrimitive | null>(null);
  // 레전드 값 provider 의 창 스코프(멀티창) — 창별로 다른 종목의 벽 값이 섞이지 않게.
  const windowId = useWindowScopeId();
  /** 가상초 → 봉 극값. 화살표 갱신은 팬·줌마다 도는데 이 맵은 캔들·축이 바뀔 때만
   *  새로 만들면 된다(캔들이 수천 개라 매 프레임 재구축은 낭비). */
  const candleExtremes = useMemo(
    () => candleExtremesByVirtualSec(candles, axis),
    [candles, axis],
  );

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

  // 순위 화살표는 **별도 primitive** 다 — 앵커가 벽 가격이 아니라 캔들 극값이라
  // 세그먼트 렌더러와 좌표계 전제가 다르고, 설정으로 따로 끌 수 있어야 한다.
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

  // 레전드 값 provider — **보이는 영역**의 잔량 상위 3개. hidden(눈)과 무관하게 유지:
  // MA의 "hide는 선만 숨기고 레전드 값은 산다" 규칙 미러.
  //
  // 보이는 범위는 **호출 시점에** 읽는다(스냅샷 금지). 팬 한 번에 이 오버레이의 rAF 와
  // 레전드 오버레이의 rAF 가 같은 `visibleLogicalRangeChange` 로 각각 깨어나는데 순서
  // 보장이 없어서, 미리 계산해 두면 팬 직후 마지막 프레임이 **이전 범위의 상위 3개**를
  // 보일 수 있다. 세그먼트 집합 자체는 팬으로 안 바뀌므로 ref + 실시간 범위면 충분하다.
  useEffect(() => {
    const provider: FlagLegendValueProvider = () => peakWallRankLegendCells(
      legendSegmentsRef.current,
      primRef.current?.chartApi()?.timeScale().getVisibleRange() ?? null,
      'ask-peak',
    );
    registerFlagLegendValues(windowId, 'ask-peak', provider);
    return () => unregisterFlagLegendValues(windowId, 'ask-peak', provider);
  }, [windowId]);

  const updateSegments = useCallback(() => {
    const prim = primRef.current;
    const arrowPrim = arrowPrimRef.current;
    if (!prim) return;
    if (!enabled) {
      prim.setSegments([]);
      arrowPrim?.setArrows([], 0);
      legendSegmentsRef.current = [];
      return;
    }
    const baselineRankLimit = toPeakRankLimit(allPriceRankLimit);
    const rawSegments = buildPeakWallOverlaySegments({
      peaks: dayAskPeaks,
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
    });
    // 레전드는 눈(hidden)과 무관하게 값을 유지하므로 **그리기 게이트보다 먼저** 채운다.
    // 여기서 hidden 을 먼저 걸면 눈을 끄는 순간 레전드가 비어 MA 규칙이 깨진다.
    legendSegmentsRef.current = rawSegments;
    // 화살표는 **그리기**다 — 눈(hidden)이 선과 함께 지운다(레전드 값과 다른 취급).
    // 랭킹은 primitive 가 draw 시점 범위로 하므로 여기서는 전건을 넘긴다.
    arrowPrim?.setArrows(
      hidden || !rankArrowEnabled
        ? []
        : peakWallRankArrowsFromSegments(rawSegments, 'ask', candleExtremes),
      PEAK_WALL_LEGEND_RANK_LIMIT,
    );
    if (hidden) {
      prim.setSegments([]);
      return;
    }
    prim.setSegments(preparePeakWallSegmentsForRender(rawSegments));
  }, [
    dayAskPeaks,
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
    rankArrowEnabled,
    candleExtremes,
  ]);

  // 갱신: dayAskPeaks·segments·candles·축·스타일·토글 변화 시 세그먼트 재계산.
  useEffect(() => {
    updateSegments();
  }, [updateSegments, series]);

  useEffect(() => {
    const prim = primRef.current;
    const chart = prim?.chartApi();
    if (!chart) return;
    const timeScale = chart.timeScale();
    const handler = () => {
      updateSegments();
    };
    timeScale.subscribeVisibleLogicalRangeChange(handler);
    updateSegments();
    return () => {
      safeUnsubscribe(() => timeScale.unsubscribeVisibleLogicalRangeChange(handler));
    };
  }, [series, updateSegments]);

  return null;
}

export default memo(LiveAskPeakSegments);
