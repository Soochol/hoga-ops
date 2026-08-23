import { memo, useCallback, useEffect, useRef } from 'react';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import {
  livePeakWallDockedLabelsFromSegments,
  peakLabelBudgetForBarSpacing,
} from '../chart/AskPeakSegmentsPrimitive';
import { PeakWallDockedLabelsPrimitive } from '../chart/PeakWallDockedLabelsPrimitive';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';
import type { PeakWallRenderState } from './usePeakWallRender';

type Props = {
  paneSeries: PaneSeriesMap;
  /** `usePeakWallRender` 결과 — 선 오버레이·고저 라벨 회피와 **같은 참조**를 받는다.
   *  종전엔 이 컴포넌트가 세그먼트를 자기 몫으로 다시 계산했고, 그래서 선과 라벨이
   *  어긋날 여지가 구조적으로 열려 있었다. */
  askWall: PeakWallRenderState;
  bidWall: PeakWallRenderState;
};

/**
 * 최대벽 도킹 라벨 — 벽이 걸린 분봉 위(매도)/아래(매수)에 「가격, 잔량」 칩.
 *
 * 계산은 하지 않는다. 여기 남는 것은 **줌 예산과 가시범위 컷**뿐이고, 그 둘은 팬·줌마다
 * 바뀌므로 이 컴포넌트만 `visibleLogicalRangeChange` 를 구독한다(선 오버레이는 구독하지
 * 않는다 — 그쪽 계산엔 보이는 범위가 안 들어간다).
 */
function LivePeakWallDockedLabels({ paneSeries, askWall, bidWall }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
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
    const timeScale = prim.chartApi()?.timeScale();
    const visibleRange = timeScale?.getVisibleRange() ?? null;
    // 줌 예산: barSpacing 이 좁으면(줌아웃) 0 → 라벨 전부 숨김. 넓으면 side별 qty 상위 N 만.
    const labelBudget = peakLabelBudgetForBarSpacing(timeScale?.options?.().barSpacing ?? 0);
    // side 는 라벨의 세로 방향을 가른다 — 매도는 선 위, 매수는 선 아래. 같은 분봉에
    // 양쪽 벽이 동시에 잡히는 최빈 겹침이 배치 없이 해소된다.
    prim.setLabels([
      ...livePeakWallDockedLabelsFromSegments(
        askWall.labels ? askWall.segments : [], 'ask', visibleRange, labelBudget,
      ),
      ...livePeakWallDockedLabelsFromSegments(
        bidWall.labels ? bidWall.segments : [], 'bid', visibleRange, labelBudget,
      ),
    ]);
  }, [askWall.labels, askWall.segments, bidWall.labels, bidWall.segments]);

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
