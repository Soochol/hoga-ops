import { memo, useEffect, useMemo, useRef } from 'react';
import type { IPriceLine, ISeriesApi, PriceLineOptions, SeriesType } from 'lightweight-charts';
import type { AskPeakPoint, RangeSegment } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useLivePageStore } from '../state/livePage';
import { formatQtyCompact } from '../util/formatQtyCompact';
import {
  computeViewportAskPeak,
} from './viewportAskPeak';
import type { VisibleTimeRange } from './viewportRightEdge';

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  /** Prefix ask-peak series; one viewport-anchored line is selected from this. */
  askPeakPoints: readonly AskPeakPoint[];
  visibleRange: VisibleTimeRange | null;
  segments: readonly RangeSegment[];
};

/** Viewport-anchored day ask peak overlay. The right edge of the visible chart
 *  picks one prefix point from that trading day; the renderer owns exactly one
 *  native price line. */
function LiveAskPeakSegments({ paneSeries, axis, askPeakPoints, visibleRange, segments }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useLivePageStore((s) => s.askPeakEnabled);
  const color = useLivePageStore((s) => s.askPeakColor);
  const lineWidth = useLivePageStore((s) => s.askPeakLineWidth);
  const lineRef = useRef<IPriceLine | null>(null);
  const peak = useMemo(
    () => computeViewportAskPeak(askPeakPoints, visibleRange, axis, segments),
    [askPeakPoints, visibleRange, axis, segments],
  );

  useEffect(() => {
    if (!series) return;
    const line = series.createPriceLine({
      price: peak?.price ?? 0,
      color,
      lineWidth,
      lineStyle: 0,
      lineVisible: enabled && peak != null,
      axisLabelVisible: enabled && peak != null,
      axisLabelColor: color,
      title: peak ? formatQtyCompact(peak.qty) : '',
    } as PriceLineOptions);
    lineRef.current = line;
    return () => {
      try {
        series.removePriceLine(line);
      } catch {
        /* chart already torn down */
      }
      lineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  useEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    if (!enabled || peak == null) {
      line.applyOptions({ lineVisible: false, axisLabelVisible: false, title: '' });
      return;
    }
    line.applyOptions({
      price: peak.price,
      color,
      lineWidth,
      axisLabelColor: color,
      lineVisible: true,
      axisLabelVisible: true,
      title: formatQtyCompact(peak.qty),
    });
  }, [enabled, peak, color, lineWidth]);

  return null;
}

export default memo(LiveAskPeakSegments);
