import { memo, useEffect, useMemo, useRef } from 'react';
import type { ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { Candle, RangeSegment } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useLivePageStore } from '../state/livePage';
import {
  TradeVolumePocPrimitive,
  type TradeVolumePocSegment,
} from '../chart/TradeVolumePocPrimitive';
import type { TradeVolumePoc } from './tradeVolumePoc';
import {
  registerFlagLegendValues,
  unregisterFlagLegendValues,
  type FlagLegendValueProvider,
} from './indicators/flagLegendValueRegistry';
import { formatPriceQty, legendCursorDate } from './peakLegendValues';

function hexToRgba(hex: string, opacity: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return `rgba(168, 85, 247, ${Math.max(0, Math.min(1, opacity))})`;
  const raw = match[1];
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  const alpha = Math.max(0, Math.min(1, opacity));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  pocs: readonly TradeVolumePoc[];
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  todayKst: string;
  override?: {
    enabled?: boolean;
    color?: string;
    opacity?: number;
  };
  behindSeries?: boolean;
};

export function buildTradeVolumePocSegments(
  pocs: readonly TradeVolumePoc[],
  segments: readonly RangeSegment[],
  candles: readonly Candle[],
  axis: VirtualAxis,
  todayKst: string,
  fillColor: string,
): TradeVolumePocSegment[] {
  if (pocs.length === 0 || candles.length === 0) return [];
  const byDate = new Map(segments.map((s) => [s.date, s]));
  const lastCandle = candles[candles.length - 1];
  const out: TradeVolumePocSegment[] = [];
  for (const poc of pocs) {
    const segment = byDate.get(poc.date);
    if (!segment) continue;
    const rawEndMs = poc.date === todayKst ? lastCandle.ts_ms : segment.session_close_ms;
    const segmentCandles = candles.filter(
      (candle) =>
        candle.ts_ms >= segment.session_open_ms
        && candle.ts_ms <= segment.session_close_ms
        && candle.ts_ms <= rawEndMs,
    );
    if (segmentCandles.length === 0) continue;
    const startMs = Math.max(segment.session_open_ms, segmentCandles[0].ts_ms);
    const endMs = Math.min(rawEndMs, segmentCandles[segmentCandles.length - 1].ts_ms);
    if (endMs < startMs) continue;
    out.push({
      time0: (axis.toVirtual(startMs) / 1000) as Time,
      time1: (axis.toVirtual(endMs) / 1000) as Time,
      lowPrice: poc.lowPrice,
      highPrice: poc.highPrice,
      fillColor,
    });
  }
  return out;
}

function TradeVolumePocOverlay({ paneSeries, axis, pocs, segments, candles, todayKst, override, behindSeries = false }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const storeEnabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const hidden = useLivePageStore((s) => s.tradeVolumePocHidden);
  const storeColor = useLivePageStore((s) => s.tradeVolumePocColor);
  const storeOpacity = useLivePageStore((s) => s.tradeVolumePocOpacity);
  const enabled = override?.enabled ?? storeEnabled;
  const color = override?.color ?? storeColor;
  const opacity = override?.opacity ?? storeOpacity;
  const primitiveRef = useRef<TradeVolumePocPrimitive | null>(null);
  const fillColor = useMemo(() => hexToRgba(color, opacity), [color, opacity]);
  const segment = useMemo(
    () => buildTradeVolumePocSegments(pocs, segments, candles, axis, todayKst, fillColor),
    [pocs, segments, candles, axis, todayKst, fillColor],
  );

  useEffect(() => {
    if (!series) return undefined;
    const primitive = new TradeVolumePocPrimitive({ zOrder: behindSeries ? 'bottom' : 'normal' });
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
  }, [series, behindSeries]);

  useEffect(() => {
    primitiveRef.current?.setSegments(enabled && !hidden ? segment : []);
  }, [enabled, hidden, segment, series, behindSeries]);

  // 레전드 값 provider — 커서 거래일 POC의 중심가·체결량. hidden과 무관하게 유지
  // (MA "hide는 그리기만" 규칙 미러).
  useEffect(() => {
    const provider: FlagLegendValueProvider = (cursorTimeSec) => {
      const date = legendCursorDate(axis, cursorTimeSec);
      if (date === null) return [];
      const poc = pocs.find((p) => p.date === date);
      if (!poc) return [];
      return [{ key: 'trade-volume-poc', value: formatPriceQty(poc.centerPrice, poc.qty) }];
    };
    registerFlagLegendValues('trade-volume-poc', provider);
    return () => unregisterFlagLegendValues('trade-volume-poc', provider);
  }, [pocs, axis]);

  return null;
}

export default memo(TradeVolumePocOverlay);
