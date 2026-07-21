import type {
  StudyViewListRow,
  StudyViewWriteRequest,
  StudyViewport,
} from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import { realMsToYyyymmdd, todayKstYyyymmdd } from '../live/liveDateTime';
import type { TabViewport } from '../live/viewportAnchor';
import type { LiveTimeframe } from '../state/livePage';

export function defaultStudyViewName(row: StudyViewListRow | undefined, label: string, timeframe: string): string {
  return row?.name ?? `${label} ${timeframe} 저장뷰`;
}

export function fallbackViewport(bundle: RangeBundle): StudyViewport | null {
  const candles = bundle.candles;
  const last = candles[candles.length - 1];
  if (!last) return null;
  const barSpan = Math.max(1, Math.min(200, candles.length));
  const first = candles[Math.max(0, candles.length - barSpan)];
  return {
    right_edge_ms: last.ts_ms,
    left_edge_ms: first ? first.ts_ms : last.ts_ms,
    bar_span: barSpan,
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
    left_edge_ms: captured.leftEdgeMs,
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
//
// 양 끝을 모두 실시각에 앵커한다. bar_span 역산으로 좌측을 구하던 옛 경로는 두
// 방향으로 어긋났다 — 라이브 엣지에선 span이 rightOffset 여백(14봉)까지 세는데
// 우측 앵커는 실제 캔들에 붙어 14~15봉 과거로 넘쳤고, 과거로 팬하면 여백이 없어
// inclusive 카운트가 1봉 모자라 맨 왼쪽 캔들을 잘라먹었다. left_edge_ms 가 없는
// 구 저장뷰만 그 역산으로 폴백한다.
export function visibleWindow(bundle: RangeBundle, viewport: StudyViewport) {
  const candles = bundle.candles;
  if (candles.length === 0) return { fromIndex: 0, toIndex: -1 };
  const rightIndex = candles.reduce((best, candle, index) => (
    candle.ts_ms <= viewport.right_edge_ms ? index : best
  ), 0);
  const visibleTo = Math.max(0, Math.min(candles.length - 1, rightIndex));
  const leftEdgeMs = viewport.left_edge_ms;
  if (typeof leftEdgeMs === 'number' && Number.isFinite(leftEdgeMs)) {
    const leftIndex = candles.findIndex((candle) => candle.ts_ms >= leftEdgeMs);
    // -1 = 좌측 끝이 로드된 캔들보다 미래(있을 수 없지만 방어) → 우측 끝만 남긴다.
    const visibleFrom = leftIndex === -1 ? visibleTo : Math.min(leftIndex, visibleTo);
    return { fromIndex: visibleFrom, toIndex: visibleTo };
  }
  const visibleFrom = Math.max(0, visibleTo - Math.ceil(viewport.bar_span) + 1);
  return { fromIndex: visibleFrom, toIndex: visibleTo };
}

/** hogaplay 원자료 보존 기간. 이보다 오래된 구간은 저장해도 복원할 데이터가 없다. */
export const HOGAPLAY_RETENTION_YEARS = 2;

/** 보존 하한 날짜(YYYYMMDD) — 이 날짜 이전 캔들은 저장 범위에서 잘린다. */
export function retentionFloorDate(todayYyyymmdd: string): string {
  const year = Number(todayYyyymmdd.slice(0, 4)) - HOGAPLAY_RETENTION_YEARS;
  const monthDay = todayYyyymmdd.slice(4);
  // 2/29 는 2년 전이 평년이면 존재하지 않는다 — 2/28 로 당겨 경계를 하루 넓게 잡는다.
  return `${year}${monthDay === '0229' ? '0228' : monthDay}`;
}

/**
 * 보이는 범위를 보존 기간 안으로 자른다.
 *
 * 자를 게 남지 않으면(전 구간이 보존 밖) 우측 끝만 남긴 1봉 창을 준다 — 빈 창
 * (toIndex < fromIndex)을 만들면 rangeForWindow 가 null 을 뱉어 저장 자체가
 * 조용히 실패한다.
 */
export function clampWindowToRetention(
  bundle: RangeBundle,
  window: { fromIndex: number; toIndex: number },
  todayYyyymmdd: string,
) {
  const candles = bundle.candles;
  if (window.toIndex < window.fromIndex) return window;
  const floor = retentionFloorDate(todayYyyymmdd);
  let fromIndex = window.fromIndex;
  while (fromIndex < window.toIndex && realMsToYyyymmdd(candles[fromIndex].ts_ms) < floor) {
    fromIndex += 1;
  }
  return { fromIndex, toIndex: window.toIndex };
}

/** 저장에 쓰는 최종 창 — 보이는 범위를 보존 기간으로 클램프한 결과. */
export function saveWindow(bundle: RangeBundle, viewport: StudyViewport, todayYyyymmdd: string) {
  return clampWindowToRetention(bundle, visibleWindow(bundle, viewport), todayYyyymmdd);
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
  const window = saveWindow(liveSource.bundle, viewport, todayKstYyyymmdd());
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
