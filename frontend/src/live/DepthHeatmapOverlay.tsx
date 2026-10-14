import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, ITimeScaleApi, SeriesType, Time } from 'lightweight-charts';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useActivePrefs } from '../state/chartPrefs';
import { DepthHeatmapPrimitive } from '../chart/DepthHeatmapPrimitive';
import { depthHeatmapSourceOf, depthLevelsOf, type DepthHeatmapPoint } from './depthHeatmapWire';
import { registerFlagLegendValues, unregisterFlagLegendValues, type FlagLegendValueProvider } from './indicators/flagLegendValueRegistry';
import { formatPriceQty } from './peakLegendValues';
import { useWindowIndicator, useWindowScopeId } from './workspace/windowView';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';
import { buildDepthHeatmapCells, maxQtyLevel } from './DepthHeatmapOverlayHelpers';


/** 가시 시간범위(가상초 {from,to}). 초기 마운트엔 null, 차트 teardown 중엔 throw → null.
 *  HighLowLabelsPrimitive.readVisibleRange 와 동일 관용구. */
function readVisibleRange(ts: ITimeScaleApi<Time>): { from: number; to: number } | null {
  try {
    const r = ts.getVisibleRange();
    return r ? { from: Number(r.from), to: Number(r.to) } : null;
  } catch {
    return null;
  }
}


type Props = {
  chart: IChartApi;
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  points: readonly DepthHeatmapPoint[];
};


function DepthHeatmapOverlay({ chart, paneSeries, axis, points }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useWindowIndicator((s) => s.depthHeatmapEnabled);
  const hidden = useWindowIndicator((s) => s.depthHeatmapHidden);
  const bidColor = useWindowIndicator((s) => s.depthHeatmapBidColor);
  const askColor = useWindowIndicator((s) => s.depthHeatmapAskColor);
  const maxOpacity = useWindowIndicator((s) => s.depthHeatmapMaxOpacity);
  const intraMax = useActivePrefs((p) => p.depthHeatmapIntraMax);
  const perPriceMax = useActivePrefs((p) => p.depthHeatmapPerPriceMax);
  // 두 토글 → 소스 하나. 셀·halfTick·강도 정규화·레전드가 **이 값 하나**를 나눠 쓴다.
  const sourceKind = depthHeatmapSourceOf(intraMax, perPriceMax);
  const topLevelsOnly = useActivePrefs((p) => p.depthHeatmapTopLevelsOnly);
  const topLevelCount = useActivePrefs((p) => p.depthHeatmapTopLevelCount);
  const primitiveRef = useRef<DepthHeatmapPrimitive | null>(null);
  // 레전드 값 provider 의 창 스코프(멀티창).
  const windowId = useWindowScopeId();
  // 강도 정규화 기준 = 현재 보이는 시간범위. 팬/줌 시 재정규화(HighLowLabelsPrimitive 선례).
  const [viewport, setViewport] = useState<{
    chart: IChartApi;
    axis: VirtualAxis;
    range: { from: number; to: number } | null;
  } | null>(null);
  // 새 차트/시간축에는 이전 가시범위를 적용하지 않는다. 구독이 새 범위를 읽을 때까지 대기.
  const visibleRange = viewport?.chart === chart && viewport.axis === axis ? viewport.range : null;

  // 프리미티브 부착: deps=[series]만 (bundle 파생값 금지 — 식별자 churn 함정).
  useEffect(() => {
    if (!series) return undefined;
    const primitive = new DepthHeatmapPrimitive({ zOrder: 'bottom' });
    series.attachPrimitive(primitive);
    primitiveRef.current = primitive;
    return () => {
      try {
        series.detachPrimitive(primitive);
      } catch {
        // Chart may already be torn down.
      }
      primitiveRef.current = null;
    };
  }, [series]);

  // 가시범위 구독: 팬/줌(visible logical range 변경)을 rAF 로 coalesce 해 재정규화.
  // logical range 를 쓰는 이유는 HighLowLabelsPrimitive 와 동일 — time range 는 팬 중
  // 미세 변화를 덜 흘린다. 실제 {from,to} 는 getVisibleRange(가상초)로 읽는다.
  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        setViewport({ chart, axis, range: readVisibleRange(ts) });
      });
    };
    schedule(); // 초기 1회
    ts.subscribeVisibleLogicalRangeChange(schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(schedule));
    };
  }, [chart, axis]);

  const cells = useMemo(() => {
    if (!enabled || hidden || !visibleRange) return [];
    // 가상초 {from,to} → 실 Unix-ms 로 역변환(axis.toReal 은 가상 ms 를 받는다).
    // 초기에는 범위를 읽기 전까지 기다린다 — 전 이력 셀을 만들었다 버리지 않는다.
    const fromMs = axis.toReal(visibleRange.from * 1000);
    const toMs = axis.toReal(visibleRange.to * 1000);
    return buildDepthHeatmapCells(
      points,
      axis,
      fromMs,
      toMs,
      { bidColor, askColor, maxOpacity },
      { source: sourceKind, topPerSide: topLevelsOnly ? topLevelCount : null },
    );
  }, [
    enabled, hidden, points, axis, visibleRange, bidColor, askColor, maxOpacity,
    sourceKind, topLevelsOnly, topLevelCount,
  ]);

  useEffect(() => {
    primitiveRef.current?.setCells(enabled && !hidden ? cells : []);
  }, [enabled, hidden, cells]);

  // 레전드 값 provider — 커서 시각(없으면 최신)의 스냅샷에서 매수/매도 최대 잔량
  // 레벨을 "가격, 수량"으로. 소스는 그리기와 **같은 `sourceKind`** 를 따른다 —
  // 사용자가 최대벽 값과 눈으로 대조하는 자리가 정확히 이 레전드다.
  useEffect(() => {
    const provider: FlagLegendValueProvider = (cursorTimeSec) => {
      if (points.length === 0) return [];
      const realMs = cursorTimeSec === null ? Infinity : axis.toReal(cursorTimeSec * 1000);
      const point = latestPointAtOrBefore(points, realMs);
      if (!point) return [];
      const bids = depthLevelsOf(point, 'bid', sourceKind);
      const asks = depthLevelsOf(point, 'ask', sourceKind);
      const out = [];
      const maxBid = maxQtyLevel(bids);
      if (maxBid) out.push({ key: 'dh-bid', label: '매수', color: bidColor, value: formatPriceQty(maxBid.price, maxBid.qty) });
      const maxAsk = maxQtyLevel(asks);
      if (maxAsk) out.push({ key: 'dh-ask', label: '매도', color: askColor, value: formatPriceQty(maxAsk.price, maxAsk.qty) });
      return out;
    };
    registerFlagLegendValues(windowId, 'depth-heatmap', 'main', provider);
    return () => unregisterFlagLegendValues(windowId, 'depth-heatmap', 'main', provider);
  }, [windowId, points, axis, sourceKind, bidColor, askColor]);

  return null;
}


/** points는 tMs 오름차순 — realMs 이하의 마지막 스냅샷(이진 탐색). */
function latestPointAtOrBefore(
  points: readonly DepthHeatmapPoint[],
  realMs: number,
): DepthHeatmapPoint | null {
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].tMs <= realMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? points[ans] : null;
}


export default memo(DepthHeatmapOverlay);
