import { memo, useEffect, useMemo, useRef } from 'react';
import type { ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { Candle, RangeSegment } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { formatQtyCompact } from '../util/formatQtyCompact';
import { useLivePageStore } from '../state/livePage';
import {
  TradeVolumePocPrimitive,
  type TradeVolumePocSegment,
} from '../chart/TradeVolumePocPrimitive';
import type { TradeVolumePoc } from './tradeVolumePoc';

const POC_COLOR = '#A855F7';
const POC_FILL = 'rgba(168, 85, 247, 0.12)';
const POC_LINE_WIDTH = 2;

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  pocs: readonly TradeVolumePoc[];
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  todayKst: string;
};

function formatPrice(price: number): string {
  return Math.round(price).toLocaleString('ko-KR');
}

function formatPocLabel(poc: TradeVolumePoc): string {
  return `최다거래대 ${formatPrice(poc.lowPrice)}~${formatPrice(poc.highPrice)} / ${formatQtyCompact(poc.qty)}`;
}

export function buildTradeVolumePocSegments(
  pocs: readonly TradeVolumePoc[],
  segments: readonly RangeSegment[],
  candles: readonly Candle[],
  axis: VirtualAxis,
  todayKst: string,
): TradeVolumePocSegment[] {
  if (pocs.length === 0 || candles.length === 0) return [];
  const byDate = new Map(segments.map((s) => [s.date, s]));
  const lastCandle = candles[candles.length - 1];
  const out: TradeVolumePocSegment[] = [];
  for (const poc of pocs) {
    const segment = byDate.get(poc.date);
    if (!segment) continue;
    const endMs = poc.date === todayKst ? lastCandle.ts_ms : segment.session_close_ms;
    out.push({
      time0: (axis.toVirtual(segment.session_open_ms) / 1000) as Time,
      time1: (axis.toVirtual(endMs) / 1000) as Time,
      peakTime: (axis.toVirtual(poc.t_ms) / 1000) as Time,
      lowPrice: poc.lowPrice,
      highPrice: poc.highPrice,
      centerPrice: poc.centerPrice,
      qty: poc.qty,
      label: formatPocLabel(poc),
      color: POC_COLOR,
      fillColor: POC_FILL,
      lineWidth: POC_LINE_WIDTH,
    });
  }
  return out;
}

function TradeVolumePocOverlay({ paneSeries, axis, pocs, segments, candles, todayKst }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const primitiveRef = useRef<TradeVolumePocPrimitive | null>(null);
  const segment = useMemo(
    () => buildTradeVolumePocSegments(pocs, segments, candles, axis, todayKst),
    [pocs, segments, candles, axis, todayKst],
  );

  useEffect(() => {
    if (!series) return undefined;
    const primitive = new TradeVolumePocPrimitive();
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

  useEffect(() => {
    primitiveRef.current?.setSegments(enabled ? segment : []);
  }, [enabled, segment]);

  return null;
}

export default memo(TradeVolumePocOverlay);
