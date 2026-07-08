import { memo, useEffect, useMemo, useRef } from 'react';
import type { ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useLivePageStore } from '../state/livePage';
import { DepthHeatmapPrimitive, type DepthHeatmapCell } from '../chart/DepthHeatmapPrimitive';
import type { DepthHeatmapPoint } from './depthHeatmapWire';
import { levelAlpha, visibleMaxQty } from './depthHeatmapAlpha';

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
): DepthHeatmapCell[] {
  const vmax = visibleMaxQty(points, fromMs, toMs);
  if (vmax <= 0) return [];
  const out: DepthHeatmapCell[] = [];
  for (const pt of points) {
    if (pt.tMs < fromMs || pt.tMs > toMs) continue;
    const time = (axis.toVirtual(pt.tMs) / 1000) as Time;
    const allPrices = [...pt.asks, ...pt.bids].map((l) => l.price);
    const halfTick = halfTickFor(allPrices);
    for (const lvl of pt.asks) {
      if (lvl.qty <= 0) continue;
      out.push({
        time,
        price: lvl.price,
        halfTick,
        fillColor: hexToRgba(style.askColor, levelAlpha(lvl.qty, vmax, style.maxOpacity)),
      });
    }
    for (const lvl of pt.bids) {
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
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  points: readonly DepthHeatmapPoint[];
};

function DepthHeatmapOverlay({ paneSeries, axis, points }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useLivePageStore((s) => s.depthHeatmapEnabled);
  const bidColor = useLivePageStore((s) => s.depthHeatmapBidColor);
  const askColor = useLivePageStore((s) => s.depthHeatmapAskColor);
  const maxOpacity = useLivePageStore((s) => s.depthHeatmapMaxOpacity);
  const primitiveRef = useRef<DepthHeatmapPrimitive | null>(null);

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

  const cells = useMemo(
    () => buildDepthHeatmapCells(points, axis, -Infinity, Infinity, { bidColor, askColor, maxOpacity }),
    [points, axis, bidColor, askColor, maxOpacity],
  );

  useEffect(() => {
    primitiveRef.current?.setCells(enabled ? cells : []);
  }, [enabled, cells]);

  return null;
}

export default memo(DepthHeatmapOverlay);
