import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, ITimeScaleApi, SeriesType, Time } from 'lightweight-charts';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { DepthHeatmapPrimitive, type DepthHeatmapCell } from '../chart/DepthHeatmapPrimitive';
import { netDeltaQty, type DepthDeltaLevel, type DepthDeltaPoint } from './depthDelta';
import { levelAlpha } from './depthHeatmapAlpha';
import { visibleMaxAbsDelta } from './depthDeltaAlpha';
import {
  registerFlagLegendValues,
  unregisterFlagLegendValues,
  type FlagLegendValueCell,
  type FlagLegendValueProvider,
} from './indicators/flagLegendValueRegistry';
import { formatPriceDelta } from './peakLegendValues';
import { useWindowIndicator, useWindowScopeId } from './workspace/windowView';

/** 가시 시간범위(가상초). DepthHeatmapOverlay.readVisibleRange 와 동일 관용구. */
function readVisibleRange(ts: ITimeScaleApi<Time>): { from: number; to: number } | null {
  try {
    const r = ts.getVisibleRange();
    return r ? { from: Number(r.from), to: Number(r.to) } : null;
  } catch {
    return null;
  }
}

type Rgb = { r: number; g: number; b: number };

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

/** 셀 반높이 = 그 **쪽**에서 관측된 틱의 절반. 틱은 버킷 생성 시 10단 사다리에서 구해
 *  point 에 실려 온다 — 히트맵처럼 그리는 레벨 집합에서 역산하면 안 된다. 증감 레벨은
 *  변한 가격만 남은 희소 집합이라, 한 가격만 변한 버킷은 간격을 못 구하고 두 가격이
 *  3단 떨어져 변한 버킷은 셀이 3배로 부풀어 관측되지 않은 가격까지 칠한다.
 *  매도/매수를 나눠 받는 이유는 `DepthDeltaPoint.askTick` 주석 참조(호가단위 경계). */
function halfTick(tick: number): number {
  return tick > 0 ? tick / 2 : 0.5;
}

type StyleOpts = { inColor: string; outColor: string; maxOpacity: number };

/** 순증감(net) 부호로 색을, 크기로 강도를 정한다. net===0 (같은 양이 들어왔다 빠진
 *  가격)은 셀을 만들지 않는다 — 색을 고를 수 없고, 커서 레전드가 gross 로 알려준다. */
function pushCells(
  out: DepthHeatmapCell[],
  levels: readonly DepthDeltaLevel[],
  time: Time,
  halfTick: number,
  vmax: number,
  inRgb: Rgb,
  outRgb: Rgb,
  maxOpacity: number,
): void {
  for (const lvl of levels) {
    const net = netDeltaQty(lvl);
    if (net === 0) continue;
    out.push({
      time,
      price: lvl.price,
      halfTick,
      // levelAlpha 는 qty<=0 을 0 으로 죽이므로 **절댓값**을 넘긴다 — 부호를 그대로
      // 넘기면 유출(음수) 셀이 전부 투명해져 "유출 데이터 없음"처럼 보인다.
      fillColor: rgba(net > 0 ? inRgb : outRgb, levelAlpha(Math.abs(net), vmax, maxOpacity)),
    });
  }
}

export function buildDepthDeltaCells(
  points: readonly DepthDeltaPoint[],
  axis: VirtualAxis,
  fromMs: number,
  toMs: number,
  style: StyleOpts,
): DepthHeatmapCell[] {
  // 정규화 천장은 셀이 그리는 값(|net|)과 같은 소스여야 한다.
  const vmax = visibleMaxAbsDelta(points, fromMs, toMs);
  if (vmax <= 0) return [];
  const inRgb = parseHex(style.inColor);
  const outRgb = parseHex(style.outColor);
  const out: DepthHeatmapCell[] = [];
  for (const pt of points) {
    if (pt.tMs < fromMs || pt.tMs > toMs) continue;
    const time = (axis.toVirtual(pt.tMs) / 1000) as Time;
    pushCells(out, pt.askDelta, time, halfTick(pt.askTick), vmax, inRgb, outRgb, style.maxOpacity);
    pushCells(out, pt.bidDelta, time, halfTick(pt.bidTick), vmax, inRgb, outRgb, style.maxOpacity);
  }
  return out;
}

type Props = {
  chart: IChartApi;
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  points: readonly DepthDeltaPoint[];
};

function DepthDeltaOverlay({ chart, paneSeries, axis, points }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useWindowIndicator((s) => s.depthDeltaEnabled);
  const hidden = useWindowIndicator((s) => s.depthDeltaHidden);
  const inColor = useWindowIndicator((s) => s.depthDeltaInColor);
  const outColor = useWindowIndicator((s) => s.depthDeltaOutColor);
  const maxOpacity = useWindowIndicator((s) => s.depthDeltaMaxOpacity);
  const primitiveRef = useRef<DepthHeatmapPrimitive | null>(null);
  // 레전드 값 provider 의 창 스코프(멀티창 #733) — 다른 종목 창의 값이 섞이지 않게.
  const windowId = useWindowScopeId();
  const [visibleRange, setVisibleRange] = useState<{ from: number; to: number } | null>(null);

  // 프리미티브 부착: deps=[series]만 (bundle 파생값 금지 — 식별자 churn 함정).
  // zOrder='bottom' 은 히트맵과 같다 — 반드시 캔들 **뒤**여야 한다. 'normal' 은 이름과
  // 달리 "시리즈와 같은 층"이 아니라 시리즈 paneView **다음에** 그려져 캔들 위를 덮고,
  // α 0.55 의 teal/fuchsia 가 양봉/음봉 색(DESIGN.md 의 --price-up/--price-down)을
  // 뭉개 회색·보라로 만든다. 히트맵보다 위에 오는 것은 zOrder 가 아니라 **부착 순서**로
  // 달성된다: 같은 zOrder 안에서는 attachPrimitive 순서가 곧 그리기 순서이고,
  // LiveChartRoot 가 히트맵을 먼저 마운트한다.
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

  // 가시범위 구독: 팬/줌을 rAF 로 coalesce 해 재정규화(오버레이별 독립 상태).
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
    const fromMs = visibleRange ? axis.toReal(visibleRange.from * 1000) : -Infinity;
    const toMs = visibleRange ? axis.toReal(visibleRange.to * 1000) : Infinity;
    return buildDepthDeltaCells(points, axis, fromMs, toMs, { inColor, outColor, maxOpacity });
  }, [points, axis, visibleRange, inColor, outColor, maxOpacity]);

  useEffect(() => {
    primitiveRef.current?.setCells(enabled && !hidden ? cells : []);
  }, [enabled, hidden, cells]);

  // 레전드 값 provider — 커서 시각(없으면 최신) 버킷에서 유입·유출이 가장 큰 가격을
  // 각각 한 셀로. `hidden` 은 **의도적으로 deps 에 없다**: 숨김은 그리기만 끄고
  // 레전드 등록 수명주기와 무관하다(히트맵과 동일 규약).
  useEffect(() => {
    const provider: FlagLegendValueProvider = (cursorTimeSec) => {
      if (points.length === 0) return [];
      const realMs = cursorTimeSec === null ? Infinity : axis.toReal(cursorTimeSec * 1000);
      const point = latestPointAtOrBefore(points, realMs);
      if (!point) return [];
      const all = [...point.askDelta, ...point.bidDelta];
      const out: FlagLegendValueCell[] = [];
      const topIn = maxBy(all, (l) => l.inQty);
      if (topIn && topIn.inQty > 0) {
        out.push({
          key: 'dd-in',
          label: '유입',
          color: inColor,
          value: formatPriceDelta(topIn.price, topIn.inQty, 0),
        });
      }
      const topOut = maxBy(all, (l) => l.outQty);
      if (topOut && topOut.outQty > 0) {
        out.push({
          key: 'dd-out',
          label: '유출',
          color: outColor,
          value: formatPriceDelta(topOut.price, 0, topOut.outQty),
        });
      }
      return out;
    };
    registerFlagLegendValues(windowId, 'depth-delta', provider);
    return () => unregisterFlagLegendValues(windowId, 'depth-delta', provider);
  }, [windowId, points, axis, inColor, outColor]);

  return null;
}

function maxBy<T>(items: readonly T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const s = score(item);
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return best;
}

/** points는 tMs 오름차순 — realMs 이하의 마지막 버킷(이진 탐색). */
function latestPointAtOrBefore(
  points: readonly DepthDeltaPoint[],
  realMs: number,
): DepthDeltaPoint | null {
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

export default memo(DepthDeltaOverlay);
