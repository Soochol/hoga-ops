import { memo, useEffect, useRef } from 'react';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import {
  registerFlagLegendValues,
  unregisterFlagLegendValues,
  type FlagLegendValueProvider,
} from './indicators/flagLegendValueRegistry';
import { preparePeakWallSegmentsForRender } from './peakWallSegments';
import { PEAK_WALL_LEGEND_RANK_LIMIT, peakWallRankLegendCells } from './peakWallVisibleRanking';
import { peakWallRankArrowsFromSegments } from './peakWallRankArrows';
import { PeakWallRankArrowsPrimitive } from '../chart/PeakWallRankArrowsPrimitive';
import {
  PeakWallSegmentsPrimitive,
  type PeakWallLabelSide,
  type PeakWallSegment,
} from '../chart/PeakWallSegmentsPrimitive';
import { useWindowScopeId } from './workspace/windowView';
import type { PeakWallRenderState } from './usePeakWallRender';

type Props = {
  paneSeries: PaneSeriesMap;
  side: PeakWallLabelSide;
  /** `usePeakWallRender` 결과 — 세그먼트와 「무엇이 그려지는가」 플래그. */
  wall: PeakWallRenderState;
  /** 가상초 → 봉 극값. 화살표 앵커용이고 매도·매수가 **같은 맵**을 쓴다(`LiveChartRoot` memo). */
  candleExtremes: ReadonlyMap<number, { high: number; low: number }>;
};

/**
 * 거래일별 최대벽 오버레이 — **매도·매수 공용**. candle series 에 primitive 둘을 건다:
 * 수평 세그먼트(그날 구간만 — 풀-너비 price line 이 아니라 여러 날 동시 표시)와 순위 화살표.
 *
 * 계산은 하지 않는다 — `usePeakWallRender` 가 `LiveChartRoot` 에서 한 번 하고 그 결과가
 * 여기·도킹 라벨·고저 라벨 회피 셋에 같은 참조로 내려온다. 종전엔 셋이 각자 계산했고,
 * 그 중 회피 경로만 `allPriceRankLimit` 을 빠뜨려 조용히 다른 집합을 보고 있었다.
 *
 * 방향으로 갈리는 것은 **레전드 키와 화살표 앵커(고가/저가)** 둘뿐이라 side 하나로 족하다.
 */
function LivePeakWallSegments({ paneSeries, side, wall, candleExtremes }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const windowId = useWindowScopeId();
  const legendId = side === 'ask' ? 'ask-peak' : 'bid-peak';
  const primRef = useRef<PeakWallSegmentsPrimitive | null>(null);
  const arrowPrimRef = useRef<PeakWallRankArrowsPrimitive | null>(null);
  /** 레전드가 랭킹할 세그먼트. **`hidden` 과 무관하게** 채운다 — 눈은 선만 숨기고 레전드
   *  값은 살린다(MA 규칙 미러). ref 인 이유: provider 는 비반응형 레지스트리에 등록되고
   *  레전드 렌더 시점에 lazy 하게 불리므로, 스토어/props 를 provider effect 의 deps 로
   *  끌어오면 등록·해제만 반복된다. */
  const legendSegmentsRef = useRef<readonly PeakWallSegment[]>([]);
  legendSegmentsRef.current = wall.segments;

  // 생성: series 핸들당 1회(LiveCurrentPriceLine 과 동일 — tf·종목 전환에도 핸들 유지).
  useEffect(() => {
    if (!series) return;
    const prim = new PeakWallSegmentsPrimitive();
    const arrowPrim = new PeakWallRankArrowsPrimitive();
    series.attachPrimitive(prim);
    series.attachPrimitive(arrowPrim);
    primRef.current = prim;
    arrowPrimRef.current = arrowPrim;
    return () => {
      try {
        series.detachPrimitive(prim);
        series.detachPrimitive(arrowPrim);
      } catch {
        /* chart already torn down */
      }
      primRef.current = null;
      arrowPrimRef.current = null;
    };
  }, [series]);

  // 레전드 값 provider — **보이는 영역**의 잔량 상위 3개.
  //
  // 보이는 범위는 **호출 시점에** 읽는다(스냅샷 금지). 팬 한 번에 이 오버레이와 레전드
  // 오버레이가 각각 깨어나는데 순서 보장이 없어서, 미리 계산해 두면 팬 직후 마지막
  // 프레임이 **이전 범위의 상위 3개**를 보일 수 있다. 세그먼트 집합 자체는 팬으로 안
  // 바뀌므로 ref + 실시간 범위면 충분하다.
  useEffect(() => {
    const provider: FlagLegendValueProvider = () => peakWallRankLegendCells(
      legendSegmentsRef.current,
      primRef.current?.chartApi()?.timeScale().getVisibleRange() ?? null,
      legendId,
    );
    registerFlagLegendValues(windowId, legendId, provider);
    return () => unregisterFlagLegendValues(windowId, legendId, provider);
  }, [windowId, legendId]);

  // 그리기 — 팬·줌은 구독하지 않는다. 이 계산에 보이는 범위가 들어가지 않기 때문이다
  // (레전드 셀·순위 화살표·고저 라벨 회피는 전부 draw 시점에 랭킹한다). 범위를 읽는
  // 입력을 다시 넣으면 구독도 같이 되살려야 한다.
  useEffect(() => {
    primRef.current?.setSegments(
      wall.drawn ? preparePeakWallSegmentsForRender(wall.segments) : [],
    );
    arrowPrimRef.current?.setArrows(
      wall.arrows ? peakWallRankArrowsFromSegments(wall.segments, side, candleExtremes) : [],
      PEAK_WALL_LEGEND_RANK_LIMIT,
    );
  }, [candleExtremes, series, side, wall]);

  return null;
}

export default memo(LivePeakWallSegments);
