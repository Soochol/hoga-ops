import { memo, useCallback, useEffect, useRef } from 'react';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { LiveTimeframe } from '../state/livePage';
import { useActivePrefs } from '../state/chartPrefs';
import {
  HighLowLabelsPrimitive,
  type HighLowLabelsSnapshot,
} from '../chart/HighLowLabelsPrimitive';
import type { AvoidRect, AvoidWallLabel } from '../chart/highLowLabelLayout';
import { findLegendRoot, legendAvoidRects } from './legendAvoidRects';

export type { AvoidWallLabel };

type Props = {
  chart: IChartApi;
  /** 캔들 경로 bundle(cb) — 극값·기준가 산출 입력. */
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
  timeframe: LiveTimeframe;
  /** Ask/Bid Peak(최대벽) 도킹 라벨들. 픽셀이 아닌 가격/시각을 넘기는 이유: 좌표 변환은
   *  축 스케일 스냅샷이라, 상위에서 미리 구우면 오토스케일·팬/줌 시 회피 rect 가 낡는다.
   *  primitive.draw 가 매 프레임 변환한다. */
  avoidWallLabels?: readonly AvoidWallLabel[];
};

function measureLegendRects(chart: IChartApi, series: ISeriesApi<SeriesType>): AvoidRect[] {
  try {
    const chartEl = chart.chartElement?.();
    if (!(chartEl instanceof Element)) return [];
    return legendAvoidRects(chartEl, series.getPane().getHeight());
  } catch {
    // 차트 teardown 레이스 — 회피 없이 그린다(다음 측정에서 self-heal).
    return [];
  }
}

function sameRects(a: readonly AvoidRect[], b: readonly AvoidRect[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => (
    r.top === b[i].top && r.bottom === b[i].bottom && r.left === b[i].left && r.right === b[i].right
  ));
}

/**
 * 고저 극값 라벨의 primitive 호스트 — DOM 을 그리지 않고 캔들 series 에
 * `HighLowLabelsPrimitive` 를 붙인 뒤 매 프레임 draw 가 pull 할 스냅샷만 갱신한다.
 * 팬/줌 재계산은 lwc 의 캔버스 패스가 담당하므로 여기엔 range 구독이 없다(그게 옛
 * DOM 오버레이의 한 프레임 지연 원인이었다).
 */
function HighLowLabelsHost({ chart, bundle, axis, paneSeries, timeframe, avoidWallLabels = [] }: Props) {
  const enabled = useActivePrefs((p) => p.highLowLabelsEnabled);
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const snapshotRef = useRef<HighLowLabelsSnapshot | null>(null);
  const legendRectsRef = useRef<readonly AvoidRect[]>([]);
  const primRef = useRef<HighLowLabelsPrimitive | null>(null);

  // 스냅샷은 커밋 후 갱신하고 repaint 를 요청한다. 팬/줌은 요청 없이도 lwc 가 그리므로
  // 여기 deps 는 순수 데이터/설정 변화만 커버하면 된다.
  useEffect(() => {
    snapshotRef.current = enabled
      ? {
        candles: bundle.candles,
        axis,
        timeframe,
        avoidWallLabels,
        legendRects: legendRectsRef.current,
      }
      : null;
    primRef.current?.requestUpdate();
  }, [enabled, bundle, axis, timeframe, avoidWallLabels]);

  useEffect(() => {
    if (!series || !enabled) return;
    const prim = new HighLowLabelsPrimitive(() => snapshotRef.current);
    series.attachPrimitive(prim);
    primRef.current = prim;
    prim.requestUpdate();
    return () => {
      try {
        series.detachPrimitive(prim);
      } catch {
        /* chart already torn down */
      }
      primRef.current = null;
    };
  }, [series, enabled]);

  const remeasureLegend = useCallback(() => {
    if (!series) return;
    const next = measureLegendRects(chart, series);
    if (sameRects(next, legendRectsRef.current)) return;
    legendRectsRef.current = next;
    const snap = snapshotRef.current;
    if (snap) snapshotRef.current = { ...snap, legendRects: next };
    primRef.current?.requestUpdate();
  }, [chart, series]);

  // 레전드 재측정 트리거: 차트 리사이즈(RO) + 레전드 DOM 변화(MO — 행 추가/삭제,
  // 크로스헤어 호버로 값 텍스트가 바뀌며 행 폭이 변하는 경우). rAF 1틱 coalesce.
  useEffect(() => {
    if (!series || !enabled) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        remeasureLegend();
      });
    };
    schedule();
    const chartEl = chart.chartElement?.();
    const ro = typeof ResizeObserver !== 'undefined' && chartEl instanceof Element
      ? new ResizeObserver(schedule)
      : null;
    if (ro && chartEl instanceof Element) ro.observe(chartEl);
    const legendRoot = chartEl instanceof Element ? findLegendRoot(chartEl) : null;
    const mo = typeof MutationObserver !== 'undefined' && legendRoot
      ? new MutationObserver(schedule)
      : null;
    if (mo && legendRoot) {
      mo.observe(legendRoot, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [chart, series, enabled, remeasureLegend]);

  return null;
}

// memo: 캔들 경로(cb·안정) props 라 SSE 호가 틱엔 재렌더되지 않음(PaneLegendOverlay 선례).
export default memo(HighLowLabelsHost);
