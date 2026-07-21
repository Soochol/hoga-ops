import type {
  StudyViewListRow,
  StudyViewWriteRequest,
  StudyViewport,
} from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import { realMsToYyyymmdd } from '../live/liveDateTime';
import type { TabViewport } from '../live/viewportAnchor';
import type { LiveTimeframe } from '../state/livePage';

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
  captureViewport: () => TabViewport | null,
  fallback: StudyViewport | null,
): StudyViewport | null {
  const captured = captureViewport();
  if (!captured) return fallback;
  return {
    right_edge_ms: captured.rightEdgeMs,
    bar_span: captured.barSpan,
    at_live_edge: captured.atLiveEdge,
    ...(typeof captured.rightPaddingBars === 'number' && Number.isFinite(captured.rightPaddingBars)
      ? { right_padding_bars: Math.max(0, captured.rightPaddingBars) }
      : {}),
  };
}

// 저장 범위 = 화면에 보이는 캔들 범위 그대로. 예전 스냅샷(캔들 동결 저장) 시절의
// 최소 200봉 확장(chooseSnapshotWindow)은 재조회 방식 전환 후 근거를 잃었고,
// 일봉처럼 보이는 봉이 200개 미만인 타임프레임에서 저장 기간만 부풀렸다.
export function visibleWindow(bundle: RangeBundle, viewport: StudyViewport) {
  const candles = bundle.candles;
  if (candles.length === 0) return { fromIndex: 0, toIndex: -1 };
  const rightIndex = candles.reduce((best, candle, index) => (
    candle.ts_ms <= viewport.right_edge_ms ? index : best
  ), 0);
  const visibleTo = Math.max(0, Math.min(candles.length - 1, rightIndex));
  const visibleFrom = Math.max(0, visibleTo - Math.ceil(viewport.bar_span) + 1);
  return { fromIndex: visibleFrom, toIndex: visibleTo };
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

/**
 * 저장 대상 차트 — 창이 자기 값을 직접 넘긴다.
 *
 * 예전에는 `studySaveSource` 전역 1슬롯을 거쳤다: 저장 버튼이 차트에서 멀리
 * (전역 툴바에) 있어서 "지금 저장할 수 있는 차트가 무엇인가" 를 우편함에 적어
 * 둬야 했다. 버튼이 차트 창 헤더로 내려오며 그 우편함이 필요 없어졌다(#767).
 * `/study` 쪽 변종(`study-reference`)은 그보다 앞서 독자를 잃었고(저장뷰 드로어
 * 단순화 164f4952) 쓰기만 남아 있다가 함께 정리됐다.
 */
export type LiveStudySaveSource = {
  origin: 'live';
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  bundle: RangeBundle;
  captureViewport: () => TabViewport | null;
};

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
