import { useEffect, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import type { PaneSeriesMap } from './drawing/chartCoordinates';
import { hasSyntheticCrosshair, markSyntheticCrosshair, releaseSyntheticCrosshair } from './syntheticCrosshair';
import { useTradeBrowseStore } from '../live/tradeBrowse';
import type { VirtualAxis } from '../util/virtualAxis';
import type { SyncCandle } from './cursorSync';
import { isMinuteTimeframe, isSecondTimeframe, type LiveTimeframe } from '../state/livePage';
import { TIMEFRAME_TO_MS } from '../api/types';
import type { LiveVenueOption } from '../state/liveVenue';

export function TradeBrowseCrosshair({ chart, axis, candles, paneSeries, windowId, group, code, timeframe, venue,
  onNeedCandle, enabled = true }: {
  chart: IChartApi; axis: VirtualAxis; candles: readonly SyncCandle[]; paneSeries: PaneSeriesMap;
  windowId: string | null; group: number | null; code: string | null; timeframe: LiveTimeframe; venue: LiveVenueOption;
  onNeedCandle?: (cursorMs: number) => void; enabled?: boolean;
}) {
  const session = useTradeBrowseStore(s => enabled && s.session?.origin.group === group && s.session.origin.code === code
    && s.session.seed.venue === venue ? s.session : null);
  const [drawn, setDrawn] = useState<number | null>(null);
  const requested = useRef<string | null>(null);
  const cursor = session?.cursorMs ?? null;
  const step = isSecondTimeframe(timeframe) ? Number(timeframe.slice(0, -1)) * 1000
    : isMinuteTimeframe(timeframe) ? TIMEFRAME_TO_MS[timeframe] : 0;
  let lo = 0, hi = candles.length;
  if (cursor !== null) while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].ts_ms <= cursor) lo = mid + 1; else hi = mid;
  }
  const candidate = lo > 0 ? candles[lo - 1] : null;
  const target = cursor !== null && candidate && step > 0 && cursor - candidate.ts_ms < step ? candidate : null;
  const targetMs = target?.ts_ms ?? null;
  const close = target?.close ?? null;

  useEffect(() => {
    if (cursor === null) { requested.current = null; return; }
    if (targetMs !== null || session?.origin.windowId !== windowId || !onNeedCandle) return;
    const key = `${cursor}`;
    if (requested.current === key) return;
    requested.current = key;
    onNeedCandle(cursor);
  }, [cursor, targetMs, candles, session?.origin.windowId, windowId, onNeedCandle]);

  useEffect(() => {
    const series = paneSeries.get('candle');
    if (!series || targetMs === null || close === null) return;
    let owned = false;
    let retry = 0;
    let pans = 0;
    let frame = 0;
    const paint = () => {
      const scale = chart.timeScale();
      const time = (axis.toVirtual(targetMs) / 1000) as UTCTimestamp;
      const x = scale.timeToCoordinate(time);
      const visible = scale.getVisibleLogicalRange();
      if (x !== null && visible && (x < 0 || x > scale.width())) {
        const logical = scale.coordinateToLogical(x);
        if (logical !== null) {
          const span = visible.to - visible.from;
          const margin = Math.min(3, span / 4);
          const from = Math.max(0, logical < visible.from ? logical - margin : logical - span + margin);
          if (pans++ < 2 && Math.abs(from - visible.from) > 0.001) {
            scale.setVisibleLogicalRange({ from, to: from + span });
            // lwc commits the new viewport during its next paint. Seating a
            // synthetic crosshair against the old coordinates makes that paint
            // reinterpret its saved x as a neighbouring candle.
            frame = requestAnimationFrame(paint);
            return;
          }
        }
      }
      // Data writes and viewport seating can finish in the parent's render frame.
      if (series.priceToCoordinate(close) === null || x === null) {
        if (retry++ < 2) frame = requestAnimationFrame(paint);
        return;
      }
      chart.setCrosshairPosition(close, time, series);
      markSyntheticCrosshair(chart);
      owned = true;
      setDrawn(targetMs);
    };
    frame = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(frame);
      if (owned && hasSyntheticCrosshair(chart)) { chart.clearCrosshairPosition(); releaseSyntheticCrosshair(chart); }
    };
  }, [chart, axis, paneSeries, targetMs, close]);

  useEffect(() => () => { if (windowId) useTradeBrowseStore.getState().clearChart(windowId); }, [windowId]);
  if (!session || !step) return null;
  return <span data-testid="trade-browse-crosshair" data-chart-id={windowId} data-cursor-ms={cursor}
    data-rendered-ms={targetMs === drawn ? drawn : undefined} data-state={target ? 'linked' : 'missing'}
    className="pointer-events-none sr-only">체결 탐색 차트 연동</span>;
}
