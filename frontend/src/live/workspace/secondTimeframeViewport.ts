import type { Candle } from '../../api/types';
import type { SecondTimeframe } from '../../state/livePage';
import type { LiveVenueOption } from '../../state/liveVenue';
import type { TabViewport } from '../viewportAnchor';

export type SecondTimeframeViewport = {
  code: string;
  target: SecondTimeframe;
  timeframe: SecondTimeframe;
  venue: LiveVenueOption;
  /** A bounded historical query can end at its last candle without following live. */
  followLatest: boolean;
  viewport: TabViewport;
};
type Capture = () => Omit<SecondTimeframeViewport, 'target'> | null;
const captures = new Map<string, Capture>();

/** The store snapshots synchronously before any toolbar/keyboard transition. */
export function registerSecondTimeframeViewport(id: string, capture: Capture): () => void {
  captures.set(id, capture);
  return () => { if (captures.get(id) === capture) captures.delete(id); };
}

export function captureSecondTimeframeViewport(id: string, target: SecondTimeframe, code: string | null | undefined): SecondTimeframeViewport | null {
  const captured = captures.get(id)?.();
  return captured && captured.code === code ? { ...captured, target } : null;
}

/** Preserve the observed time interval, not the old resolution's bar count.
 * Binary searches also work across nights, holidays and sparse observations. */
export function restoreSecondTimeframeViewport(transfer: SecondTimeframeViewport, candles: readonly Candle[]): TabViewport | null {
  if (!candles.length) return null;
  const { viewport } = transfer;
  const nextMs = Number(transfer.target.slice(0, -1)) * 1000;
  const ratio = Number(transfer.timeframe.slice(0, -1)) * 1000 / nextMs;
  const indexAt = (ms: number) => {
    const bucket = Math.floor(ms / nextMs) * nextMs;
    let low = 0, high = candles.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (candles[mid].ts_ms <= bucket) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, low - 1);
  };
  const right = transfer.followLatest ? candles.length - 1 : indexAt(viewport.rightEdgeMs);
  const padding = viewport.rightPaddingBars;
  const nextPadding = padding === undefined ? undefined : Math.max(0, (1 + padding) * ratio - 1);
  // getVisibleRange includes a partially visible boundary candle. Repeated
  // switches must not add that candle to the zoom on every transition. A dense
  // interval can preserve its precise logical duration; sparse/day-gap ranges
  // instead use observed indices on the new grid.
  const observedSpan = viewport.barSpan - (padding === undefined ? 0 : 1 + padding);
  const elapsedBars = viewport.leftEdgeMs === undefined ? null
    : (viewport.rightEdgeMs - viewport.leftEdgeMs) / (Number(transfer.timeframe.slice(0, -1)) * 1000);
  const dense = elapsedBars !== null && Math.abs(elapsedBars - observedSpan) <= 1.00001;
  const barSpan = viewport.leftEdgeMs === undefined || dense ? viewport.barSpan * ratio
    : right - indexAt(viewport.leftEdgeMs) + (nextPadding === undefined ? 0 : 1 + nextPadding);
  return { rightEdgeMs: candles[right].ts_ms, barSpan: Math.max(1, barSpan),
    atLiveEdge: viewport.atLiveEdge, userAdjusted: true,
    ...(nextPadding === undefined ? {} : { rightPaddingBars: nextPadding }) };
}
