import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, ITimeScaleApi, SeriesType, Time } from 'lightweight-charts';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useActivePrefs } from '../state/chartPrefs';
import { DepthHeatmapPrimitive, type DepthHeatmapCell } from '../chart/DepthHeatmapPrimitive';
import type { DepthHeatmapPoint } from './depthHeatmapWire';
import { levelAlpha, visibleMaxQty } from './depthHeatmapAlpha';
import {
  registerFlagLegendValues,
  unregisterFlagLegendValues,
  type FlagLegendValueProvider,
} from './indicators/flagLegendValueRegistry';
import { formatPriceQty } from './peakLegendValues';
import { useWindowIndicator, useWindowScopeId } from './workspace/windowView';

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

type Rgb = { r: number; g: number; b: number };

// base hex 는 build 내내 고정(bidColor/askColor)이라 셀마다 regex+parseInt 로 재파싱하지
// 않는다 — build 진입 시 1회 파싱해 두고 alpha 만 셀별로 포맷한다.
function parseHex(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return { r: 128, g: 128, b: 128 };
  const raw = match[1];
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function rgba(c: Rgb, opacity: number): string {
  const alpha = Math.max(0, Math.min(1, opacity));
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
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

// halfTick 은 point 의 가격 집합에만 의존(vmax·가시범위 무관)하고, IncrementalHogaBucketer
// 가 미변경 버킷에 안정적인 point 참조를 주므로(depthHeatmapWire 불변식) point 별로 1회만
// 계산한다. SSE 틱마다 전 point 를 정렬(+ allPrices 스프레드 할당)하던 것을 실제 바뀐
// 버킷 1개로 줄인다. close/max 는 소스 레벨이 달라 변형별로 따로 캐시.
const _halfTickCache = new WeakMap<DepthHeatmapPoint, { close?: number; max?: number }>();

function halfTickForPoint(pt: DepthHeatmapPoint, intraMax: boolean): number {
  let entry = _halfTickCache.get(pt);
  if (entry === undefined) {
    entry = {};
    _halfTickCache.set(pt, entry);
  }
  const cached = intraMax ? entry.max : entry.close;
  if (cached !== undefined) return cached;
  const asks = intraMax ? pt.asksMax : pt.asks;
  const bids = intraMax ? pt.bidsMax : pt.bids;
  const value = halfTickFor([...asks, ...bids].map((l) => l.price));
  if (intraMax) entry.max = value;
  else entry.close = value;
  return value;
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
  const askRgb = parseHex(style.askColor);
  const bidRgb = parseHex(style.bidColor);
  const out: DepthHeatmapCell[] = [];
  for (const pt of points) {
    if (pt.tMs < fromMs || pt.tMs > toMs) continue;
    const asks = intraMax ? pt.asksMax : pt.asks;
    const bids = intraMax ? pt.bidsMax : pt.bids;
    const time = (axis.toVirtual(pt.tMs) / 1000) as Time;
    const halfTick = halfTickForPoint(pt, intraMax);
    for (const lvl of asks) {
      if (lvl.qty <= 0) continue;
      out.push({
        time,
        price: lvl.price,
        halfTick,
        fillColor: rgba(askRgb, levelAlpha(lvl.qty, vmax, style.maxOpacity)),
      });
    }
    for (const lvl of bids) {
      if (lvl.qty <= 0) continue;
      out.push({
        time,
        price: lvl.price,
        halfTick,
        fillColor: rgba(bidRgb, levelAlpha(lvl.qty, vmax, style.maxOpacity)),
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
  const enabled = useWindowIndicator((s) => s.depthHeatmapEnabled);
  const hidden = useWindowIndicator((s) => s.depthHeatmapHidden);
  const bidColor = useWindowIndicator((s) => s.depthHeatmapBidColor);
  const askColor = useWindowIndicator((s) => s.depthHeatmapAskColor);
  const maxOpacity = useWindowIndicator((s) => s.depthHeatmapMaxOpacity);
  const intraMax = useActivePrefs((p) => p.depthHeatmapIntraMax);
  const primitiveRef = useRef<DepthHeatmapPrimitive | null>(null);
  // 레전드 값 provider 의 창 스코프(멀티창).
  const windowId = useWindowScopeId();
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
    primitiveRef.current?.setCells(enabled && !hidden ? cells : []);
  }, [enabled, hidden, cells]);

  // 레전드 값 provider — 커서 시각(없으면 최신)의 스냅샷에서 매수/매도 최대 잔량
  // 레벨을 "가격, 수량"으로. 셀 소스는 그리기와 동일하게 intraMax를 따른다.
  useEffect(() => {
    const provider: FlagLegendValueProvider = (cursorTimeSec) => {
      if (points.length === 0) return [];
      const realMs = cursorTimeSec === null ? Infinity : axis.toReal(cursorTimeSec * 1000);
      const point = latestPointAtOrBefore(points, realMs);
      if (!point) return [];
      const bids = intraMax ? point.bidsMax : point.bids;
      const asks = intraMax ? point.asksMax : point.asks;
      const out = [];
      const maxBid = maxQtyLevel(bids);
      if (maxBid) out.push({ key: 'dh-bid', label: '매수', color: bidColor, value: formatPriceQty(maxBid.price, maxBid.qty) });
      const maxAsk = maxQtyLevel(asks);
      if (maxAsk) out.push({ key: 'dh-ask', label: '매도', color: askColor, value: formatPriceQty(maxAsk.price, maxAsk.qty) });
      return out;
    };
    registerFlagLegendValues(windowId, 'depth-heatmap', provider);
    return () => unregisterFlagLegendValues(windowId, 'depth-heatmap', provider);
  }, [windowId, points, axis, intraMax, bidColor, askColor]);

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

function maxQtyLevel(
  levels: readonly { price: number; qty: number }[],
): { price: number; qty: number } | null {
  let best: { price: number; qty: number } | null = null;
  for (const level of levels) {
    if (best === null || level.qty > best.qty) best = level;
  }
  return best;
}

export default memo(DepthHeatmapOverlay);
