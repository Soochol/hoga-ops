/**
 * 날짜 구분선이 설 **가상 시각**을 정한다 — 개장 정각이 아니라 **그 세션에서 실제로
 * 렌더되는 첫 캔들**의 시각이다.
 *
 * ## 왜 개장 정각이면 안 되는가
 *
 * lightweight-charts 의 시간축은 연속 시간축이 아니라 **데이터 포인트의 인덱스 축**이다.
 * `timeToCoordinate(t)` 는 "t 가 축의 어디쯤인가" 를 보간하지 않고 **t 인 포인트를 조회**해
 * 그 x 를 준다 — 없으면 `null`. 그래서 시간 도메인에서 완벽히 유효한 값(세션 개장
 * 09:00:00 = `segment.virtualStart`)이 좌표 도메인에는 없을 수 있다.
 *
 * 그 날의 첫 캔들이 개장 정각이 아니면(첫 버킷에 체결이 없거나 캡처가 늦게 시작)
 * `virtualStart` 에는 포인트가 없어 좌표가 `null` 이 되고, `DayBoundaryOverlay` 가 그
 * 줄을 통째로 건너뛴다. **캔들은 정상적으로 그려지는데 구분선만 조용히 사라진다** —
 * 에러도 경고도 없다.
 *
 * 실측 (005380 · 3분봉 · 20260211~20260608, 세그먼트 69개):
 *   - 20260318 첫 캔들 = 개장 +6분 → 구분선 없음
 *   - 20260602 첫 캔들 = 개장 +12분 → 구분선 없음
 *   - 나머지 67일은 delta 0 → 정상
 *   - `timeToCoordinate(20260602 virtualStart)` = **null**,
 *     같은 축에서 그 날 첫 캔들(09:12) = 372.08px
 *
 * ## 기준이 raw 캔들이 아니라 **렌더되는** 캔들인 이유
 *
 * `projectCandleRows` 는 `classifyAndProject().contained` 가 false 인 캔들을 버린다
 * (장외·갭 구간). 버려진 캔들을 경계로 잡으면 축에 없는 시각을 다시 가리켜 같은
 * `null` 이 재발한다. 그래서 여기서도 **같은 술어로** 거른다 — 두 곳이 같은 축을
 * 같은 방식으로 두드리는 것이 이 모듈의 계약이다.
 *
 * 캔들이 하나도 없는 세그먼트는 경계를 내지 않는다(그릴 자리가 없다). 종전 동작도
 * 결과적으로 같았다 — `virtualStart` 좌표가 `null` 이라 안 그려졌을 뿐이다.
 */

import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { lowerBoundCandle } from './projectors/candle';

export type DayBoundaryTick = Readonly<{
  /** YYYYMMDD KST — 경계가 여는 세그먼트의 거래일. */
  date: string;
  /** 구분선이 설 가상 시각(ms). 캔들 시각과 **정확히 같아야** 좌표가 나온다. */
  virtualMs: number;
}>;

export const NO_DAY_BOUNDARY_TICKS: readonly DayBoundaryTick[] = Object.freeze([]);

/**
 * N 세그먼트 → 최대 N-1 경계. `segments[0]` 은 경계를 열지 않는다(축의 시작).
 *
 * 비용은 경계당 이분 탐색 한 번 — 세그먼트 69개 × log2(8886) ≈ 970 비교로, 캔들
 * 배열이 바뀔 때만 돈다. 세그먼트 안에서 앞으로 훑는 루프는 첫 캔들이 장외로 걸러진
 * 드문 경우에만 두 걸음 이상 간다.
 */
export function resolveDayBoundaryTicks(
  candles: readonly Candle[],
  axis: VirtualAxis,
): readonly DayBoundaryTick[] {
  if (axis.segments.length < 2 || candles.length === 0) return NO_DAY_BOUNDARY_TICKS;

  const out: DayBoundaryTick[] = [];
  for (let i = 1; i < axis.segments.length; i++) {
    const seg = axis.segments[i];
    for (let j = lowerBoundCandle(candles, seg.sessionOpenMs); j < candles.length; j++) {
      const ts = candles[j].ts_ms;
      if (ts > seg.sessionCloseMs) break;
      const { contained, virtual } = axis.classifyAndProject(ts);
      if (!contained) continue;
      out.push(Object.freeze({ date: seg.date, virtualMs: virtual }));
      break;
    }
  }
  return out.length === 0 ? NO_DAY_BOUNDARY_TICKS : Object.freeze(out);
}

/**
 * 두 결과가 값으로 같은가 — 참조 안정화용.
 *
 * `/live` 는 SSE 틱마다 `bundle.candles` 배열을 새로 만든다. 그때마다 새 배열을
 * 내려보내면 `DayBoundaryOverlay` 의 `memo` 가 매 틱 깨진다(그 memo 는 축 참조가
 * 안정하다는 전제로 2026-06-09 Phase B 가 세운 것이다). 오늘 캔들이 붙어도 **각
 * 세션의 첫 캔들은 바뀌지 않으므로** 값 비교로 이전 참조를 그대로 유지할 수 있다.
 */
export function sameDayBoundaryTicks(
  a: readonly DayBoundaryTick[],
  b: readonly DayBoundaryTick[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].date !== b[i].date || a[i].virtualMs !== b[i].virtualMs) return false;
  }
  return true;
}
