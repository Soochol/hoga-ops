import type {
  StudyViewListRow,
  StudyViewWriteRequest,
  StudyViewport,
} from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import { realMsToYyyymmdd } from '../live/liveDateTime';
import { chooseSnapshotWindow } from './snapshotWindow';
import type { LiveStudySaveSource } from './studySaveSource';

export function defaultStudyViewName(row: StudyViewListRow | undefined, label: string, timeframe: string): string {
  return row?.name ?? `${label} ${timeframe} 저장뷰`;
}

export function fallbackViewport(bundle: RangeBundle): StudyViewport | null {
  const last = bundle.candles[bundle.candles.length - 1];
  if (!last) return null;
  return {
    right_edge_ms: last.ts_ms,
    bar_span: Math.max(1, Math.min(200, bundle.candles.length)),
    at_live_edge: true,
  };
}

export function viewportFromCapture(
  captureViewport: () => { rightEdgeMs: number; barSpan: number; atLiveEdge: boolean } | null,
  fallback: StudyViewport | null,
): StudyViewport | null {
  const captured = captureViewport();
  if (!captured) return fallback;
  return {
    right_edge_ms: captured.rightEdgeMs,
    bar_span: captured.barSpan,
    at_live_edge: captured.atLiveEdge,
  };
}

export function visibleWindow(bundle: RangeBundle, viewport: StudyViewport) {
  const candles = bundle.candles;
  if (candles.length === 0) return { fromIndex: 0, toIndex: -1 };
  const rightIndex = candles.reduce((best, candle, index) => (
    candle.ts_ms <= viewport.right_edge_ms ? index : best
  ), 0);
  const visibleTo = Math.max(0, Math.min(candles.length - 1, rightIndex));
  const visibleFrom = Math.max(0, visibleTo - Math.ceil(viewport.bar_span) + 1);
  return chooseSnapshotWindow(candles, visibleFrom, visibleTo);
}

export function rangeForWindow(bundle: RangeBundle, fromIndex: number, toIndex: number) {
  const fromCandle = bundle.candles[Math.max(0, fromIndex)];
  const toCandle = bundle.candles[Math.max(0, toIndex)];
  if (!fromCandle || !toCandle) return null;
  return {
    from_date: realMsToYyyymmdd(fromCandle.ts_ms),
    to_date: realMsToYyyymmdd(toCandle.ts_ms),
    from_ms: fromCandle.ts_ms,
    to_ms: toCandle.ts_ms,
  };
}

export function buildStudyReferenceSaveRequest(liveSource: LiveStudySaveSource): StudyViewWriteRequest | null {
  const viewport = viewportFromCapture(liveSource.captureViewport, fallbackViewport(liveSource.bundle));
  if (!viewport) return null;
  const window = visibleWindow(liveSource.bundle, viewport);
  const range = rangeForWindow(liveSource.bundle, window.fromIndex, window.toIndex);
  if (!range) return null;
  return {
    name: defaultStudyViewName(undefined, liveSource.label, liveSource.timeframe),
    memo: '',
    code: liveSource.code,
    label: liveSource.label,
    timeframe: liveSource.timeframe,
    range,
    viewport,
    tags: [],
  };
}

export const buildLiveStudySaveRequest = buildStudyReferenceSaveRequest;
