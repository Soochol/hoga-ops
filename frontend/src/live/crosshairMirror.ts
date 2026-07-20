/**
 * 크로스헤어 미러 순수 로직 (ADR-0119 PR-D2).
 *
 * 같은 링크 그룹의 다른 차트 창이 호버 중이면 그 커서 시각을 내 축에 동기한다
 * (#708 "창 간 동기화 = 크로스헤어 시간만"). LiveChartRoot 의 imperative 미러
 * effect 가 이 순수 함수들로 판정·가격을 계산한다(렌더 없이 단위 테스트 가능).
 */
import type { SidebarCursorOrigin } from './useLiveCursorStore';

/**
 * 이 차트가 미러를 그려야 하는가. 참이려면:
 * - 나는 워크스페이스 창이다(myWindowId 非null — /study·단일 뷰는 불참).
 * - 커서가 활성이다(cursorMs 非null).
 * - 발행 출처가 **같은 그룹의 다른 창**이다(origin.group === myGroup 且 windowId ≠ 나).
 * 내가 발행자면(origin.windowId === myWindowId) 미러하지 않는다(자기 크로스헤어는
 * lwc 가 이미 그린다).
 */
export function shouldMirrorCursor(args: {
  myWindowId: string | null;
  myGroup: number | null;
  cursorMs: number | null;
  origin: SidebarCursorOrigin | null;
}): boolean {
  const { myWindowId, myGroup, cursorMs, origin } = args;
  return (
    myWindowId !== null &&
    cursorMs !== null &&
    origin !== null &&
    origin.group === myGroup &&
    origin.windowId !== myWindowId
  );
}

/**
 * 미러의 가격 인자 — cursorMs 이하(없으면 첫 봉)의 가장 가까운 봉 close.
 * lwc setCrosshairPosition 은 price+series 가 필수라, 수직선은 vt 로 놓되 수평선은
 * 그 봉 종가에 둔다. 봉이 없으면 null(미러 스킵). candles 는 ts_ms 오름차순 전제.
 */
export function mirrorCandleClose(
  candles: readonly { ts_ms: number; close: number }[],
  cursorMs: number,
): number | null {
  if (candles.length === 0) return null;
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (candles[mid].ts_ms <= cursorMs) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo].close;
}
