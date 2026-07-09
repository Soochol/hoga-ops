import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, ITimeScaleApi, SeriesType, Time } from 'lightweight-charts';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useLivePageStore } from '../state/livePage';
import { useActivePrefs } from '../state/chartPrefs';
import { DepthHeatmapPrimitive, type DepthHeatmapCell } from '../chart/DepthHeatmapPrimitive';
import type { DepthHeatmapPoint } from './depthHeatmapWire';
import { levelAlpha, visibleMaxQty } from './depthHeatmapAlpha';

/** 가시 시간범위(가상초 {from,to}). 초기 마운트엔 null, 차트 teardown 중엔 throw → null.
 *  HighLowAnnotationOverlay.readVisibleRange 와 동일 관용구. */
function readVisibleRange(ts: ITimeScaleApi<Time>): { from: number; to: number } | null {
  try {
    const r = ts.getVisibleRange();
    return r ? { from: Number(r.from), to: Number(r.to) } : null;
  } catch {
    return null;
  }
}

function hexToRgba(hex: string, opacity: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  const alpha = Math.max(0, Math.min(1, opacity));
  if (!match) return `rgba(128, 128, 128, ${alpha})`;
  const raw = match[1];
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function halfTickFor(prices: number[]): number {
  let minGap = Infinity;
  const sorted = [...prices].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  if (!Number.isFinite(minGap)) return 0.5;
  return minGap / 2;
}

type StyleOpts = { bidColor: string; askColor: string; maxOpacity: number };

export function buildDepthHeatmapCells(
  points: readonly DepthHeatmapPoint[],
  axis: VirtualAxis,
  fromMs: number,
  toMs: number,
  style: StyleOpts,
  intraMax = false,
): DepthHeatmapCell[] {
  // 정규화 천장은 셀 소스와 반드시 같아야 한다 → intraMax 를 그대로 전달.
  const vmax = visibleMaxQty(points, fromMs, toMs, intraMax);
  if (vmax <= 0) return [];
  const out: DepthHeatmapCell[] = [];
  for (const pt of points) {
    if (pt.tMs < fromMs || pt.tMs > toMs) continue;
    const asks = intraMax ? pt.asksMax : pt.asks;
    const bids = intraMax ? pt.bidsMax : pt.bids;
    const time = (axis.toVirtual(pt.tMs) / 1000) as Time;
    const allPrices = [...asks, ...bids].map((l) => l.price);
    const halfTick = halfTickFor(allPrices);
    for (const lvl of asks) {
      if (lvl.qty <= 0) continue;
      out.push({
        time,
        price: lvl.price,
        halfTick,
        fillColor: hexToRgba(style.askColor, levelAlpha(lvl.qty, vmax, style.maxOpacity)),
      });
    }
    for (const lvl of bids) {
      if (lvl.qty <= 0) continue;
      out.push({
        time,
        price: lvl.price,
        halfTick,
        fillColor: hexToRgba(style.bidColor, levelAlpha(lvl.qty, vmax, style.maxOpacity)),
      });
    }
  }
  return out;
}

type Props = {
  chart: IChartApi;
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  points: readonly DepthHeatmapPoint[];
};

function DepthHeatmapOverlay({ chart, paneSeries, axis, points }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useLivePageStore((s) => s.depthHeatmapEnabled);
  const bidColor = useLivePageStore((s) => s.depthHeatmapBidColor);
  const askColor = useLivePageStore((s) => s.depthHeatmapAskColor);
  const maxOpacity = useLivePageStore((s) => s.depthHeatmapMaxOpacity);
  const intraMax = useActivePrefs((p) => p.depthHeatmapIntraMax);
  const primitiveRef = useRef<DepthHeatmapPrimitive | null>(null);
  // 강도 정규화 기준 = 현재 보이는 시간범위. 팬/줌 시 재정규화(HighLowAnnotationOverlay 선례).
  const [visibleRange, setVisibleRange] = useState<{ from: number; to: number } | null>(null);

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
  // logical range 를 쓰는 이유는 HighLowAnnotationOverlay 와 동일 — time range 는 팬 중
  // 미세 변화를 덜 흘린다. 실제 {from,to} 는 getVisibleRange(가상초)로 읽는다.
  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        setVisibleRange(readVisibleRange(ts));
      });
    };
    schedule(); // 초기 1회
    ts.subscribeVisibleLogicalRangeChange(schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
    };
  }, [chart]);

  const cells = useMemo(() => {
    // 가상초 {from,to} → 실 Unix-ms 로 역변환(axis.toReal 은 가상 ms 를 받는다).
    // 초기(range 미확정) 프레임은 전 범위 폴백 후, 첫 구독 콜백에서 화면 범위로 좁힌다.
    const fromMs = visibleRange ? axis.toReal(visibleRange.from * 1000) : -Infinity;
    const toMs = visibleRange ? axis.toReal(visibleRange.to * 1000) : Infinity;
    return buildDepthHeatmapCells(points, axis, fromMs, toMs, { bidColor, askColor, maxOpacity }, intraMax);
  }, [points, axis, visibleRange, bidColor, askColor, maxOpacity, intraMax]);

  useEffect(() => {
    primitiveRef.current?.setCells(enabled ? cells : []);
  }, [enabled, cells]);

  return null;
}

export default memo(DepthHeatmapOverlay);
