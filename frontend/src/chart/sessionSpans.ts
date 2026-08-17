/**
 * 세션의 **양 끝을 축에 실재하는 시각으로** 준다 — 개장/마감 정각이 아니라 **그
 * 세션에서 실제로 렌더되는 첫·마지막 캔들**의 시각이다.
 *
 * 오버레이가 세션 경계에 무언가를 그리려면 좌표가 필요하고, 좌표를 얻으려면 그 시각이
 * **축에 포인트로 존재**해야 한다. 도메인 상수(09:00·15:30)는 그 보장이 없다. 이
 * 모듈은 그 번역을 한 자리에서 한다 — 소비처가 각자 캔들을 뒤지면 같은 결함이 각자
 * 재발한다(실제로 두 곳에서 재발했다: `DayBoundaryOverlay` #1361,
 * `PriceLevelDotsOverlay`).
 *
 * ## 왜 개장/마감 정각이면 안 되는가
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

export type SessionSpan = Readonly<{
  /** YYYYMMDD KST 거래일. */
  date: string;
  /** 그 세션에서 렌더되는 **첫** 캔들의 가상 시각(ms). */
  firstVirtualMs: number;
  /** 그 세션에서 렌더되는 **마지막** 캔들의 가상 시각(ms). */
  lastVirtualMs: number;
}>;

export type DayBoundaryTick = Readonly<{
  /** YYYYMMDD KST — 경계가 여는 세그먼트의 거래일. */
  date: string;
  /** 구분선이 설 가상 시각(ms). 캔들 시각과 **정확히 같아야** 좌표가 나온다. */
  virtualMs: number;
}>;

export const NO_SESSION_SPANS: readonly SessionSpan[] = Object.freeze([]);
export const NO_DAY_BOUNDARY_TICKS: readonly DayBoundaryTick[] = Object.freeze([]);

/**
 * 각 세그먼트의 첫·마지막 렌더 캔들. **캔들이 하나도 없는 세그먼트는 생략된다** —
 * 그릴 자리가 없으니 항목을 내지 않는다(소비처의 `null` 분기와 같은 결론을 더 이른
 * 단계에서 낸다). 따라서 결과 길이 ≤ `axis.segments.length` 이고 **인덱스가 세그먼트
 * 인덱스와 일치한다고 가정하면 안 된다** — 날짜로 찾을 것.
 *
 * 비용은 세그먼트당 이분 탐색 한 번 + 그 세션 캔들 훑기 = 전체 O(N + M log N).
 * 실측 규모(캔들 8886 · 세그먼트 69)에서 무시할 수준이고, 캔들 배열이 바뀔 때만 돈다.
 */
export function resolveSessionSpans(
  candles: readonly Candle[],
  axis: VirtualAxis,
): readonly SessionSpan[] {
  if (axis.segments.length === 0 || candles.length === 0) return NO_SESSION_SPANS;

  const out: SessionSpan[] = [];
  for (const seg of axis.segments) {
    let first: number | null = null;
    let last: number | null = null;
    for (let j = lowerBoundCandle(candles, seg.sessionOpenMs); j < candles.length; j++) {
      const ts = candles[j].ts_ms;
      if (ts > seg.sessionCloseMs) break;
      const { contained, virtual } = axis.classifyAndProject(ts);
      if (!contained) continue;
      if (first === null) first = virtual;
      last = virtual;
    }
    if (first !== null && last !== null) {
      out.push(Object.freeze({ date: seg.date, firstVirtualMs: first, lastVirtualMs: last }));
    }
  }
  return out.length === 0 ? NO_SESSION_SPANS : Object.freeze(out);
}

/**
 * N 세그먼트 → 최대 N-1 경계. `segments[0]` 은 경계를 열지 않는다(축의 시작).
 *
 * 첫 세그먼트를 **인덱스가 아니라 날짜로** 뺀다 — `resolveSessionSpans` 가 캔들 없는
 * 세그먼트를 생략하므로 인덱스 0 이 곧 축의 첫 세그먼트라는 보장이 없다.
 */
export function resolveDayBoundaryTicks(
  candles: readonly Candle[],
  axis: VirtualAxis,
): readonly DayBoundaryTick[] {
  if (axis.segments.length < 2) return NO_DAY_BOUNDARY_TICKS;

  const firstDate = axis.segments[0].date;
  const out: DayBoundaryTick[] = [];
  for (const span of resolveSessionSpans(candles, axis)) {
    if (span.date === firstDate) continue;
    out.push(Object.freeze({ date: span.date, virtualMs: span.firstVirtualMs }));
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
