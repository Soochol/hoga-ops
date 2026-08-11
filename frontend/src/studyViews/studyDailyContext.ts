/**
 * `/study` 캘린더 봉(D/W/M)의 **맥락 창**과 저장 구간 표시 좌표.
 *
 * 복기뷰가 캘린더 봉으로 전환됐을 때 저장 구간만 그리면 일봉의 존재 이유가 없다 —
 * 10분봉 7주 저장뷰를 일봉으로 바꾸면 캔들 35개가 화면을 채우고 "이 구간이 큰 그림
 * 어디였나" 를 답할 수 없다. 그래서 저장 구간 **앞뒤로** 창을 넓히고, 저장 구간은
 * 밴드로 표시한다(`StudySavedRangeBand`).
 *
 * 넓히는 건 `screenerDaily`(디스크 일봉) **한 쪽뿐**이다. 1분봉(hogaplay) 창의
 * `initialHistoricalDaysFor` 캡은 의도된 방어이고, 캡 밖은 스크리너 일봉이 덮는다는
 * 계약이 `studyReferenceQueryInputs` 에 이미 있다.
 *
 * 이후 구간(저장 시점엔 몰랐던 미래)을 **항상 보여준다** — 2026-08-09 사용자 결정.
 * 복기의 목적이 결과 확인이라 스포일러 회피보다 맥락이 우선이라는 판단이다.
 */
import { initialHistoricalDaysFor, subtractDaysKst, todayKstYyyymmdd } from '../live/liveDateTime';
import { isMinuteTimeframe } from '../state/livePage';
import type { StudyViewReference } from '../api/studyViews';
import type { Candle } from '../api/types';

export type StudyDailyContextWindow = { from: string; to: string } | null;

/**
 * 캘린더 봉으로 볼 때의 조회·클립 창. **분봉이면 null** — 분봉 경로는 저장 구간이
 * 곧 화면이므로 창을 넓힐 이유도, 넓혀서 생기는 추가 fetch 를 감수할 이유도 없다.
 *
 * 앞: 저장 구간 시작에서 `/live` 일봉 초기 창과 같은 250봉만큼. 새 상수를 만들지
 * 않는 이유는 "라이브에서 보던 만큼" 이 사용자 기대치이기 때문이다.
 * 뒤: 오늘. 디스크 일봉이라 넓혀도 벤더 호출이 늘지 않는다.
 */
export function studyDailyContextWindow(save: StudyViewReference | null): StudyDailyContextWindow {
  if (!save || isMinuteTimeframe(save.timeframe)) return null;
  return {
    from: subtractDaysKst(save.range.from_date, initialHistoricalDaysFor('D')),
    to: todayKstYyyymmdd(),
  };
}

/**
 * 일봉 몸통이 읽히는 최대 가시 span.
 *
 * `LiveChartRoot` 의 `DAILY_MIN_EFFECTIVE_BAR_SPACING = 3.5`(#141 이 정한 하한)를
 * `/study` 차트 창의 실측 플롯 폭 ~562px 로 나눈 값이다. **px 에서 유도한 상수라
 * 밀도·레이아웃이 바뀌면 여기가 같이 틀어진다** — 상한이지 목표치가 아니고,
 * 넘기면 캔들이 몸통 없는 실선으로 붕괴한다.
 */
export const MAX_LEGIBLE_DAILY_SPAN = 160;

/** 저장 구간 우측으로 더 보여줄 비율. 0이면 받아온 이후 구간이 전부 화면 밖이라
 *  "이후를 보여준다" 는 결정이 화면에 드러나지 않는다. */
const AFTER_RANGE_RATIO = 0.35;

/** 저장 구간이 화면에서 차지할 비율의 역수 — 2.2 면 저장 구간이 우측 ~45%. */
const CONTEXT_SPAN_RATIO = 2.2;

export type StudyDailyViewport = {
  rightEdgeMs: number;
  barSpan: number;
  atLiveEdge: boolean;
};

/**
 * 캘린더 봉 초기 뷰포트. 저장 구간의 마지막 캔들에서 이후 구간 쪽으로 조금 민 지점을
 * 우측 앵커로 잡고, span 은 저장 구간의 `CONTEXT_SPAN_RATIO` 배(가독 상한 클램프).
 *
 * `atLiveEdge: false` 가 핵심이다 — true 면 `computeRestoreRange` 가 최신 봉을
 * 따라가 저장 구간이 화면 밖으로 밀린다.
 */
export function studyDailyViewport(
  candles: readonly Candle[],
  savedFromMs: number,
  savedToMs: number,
): StudyDailyViewport | null {
  if (candles.length === 0) return null;
  const inRange = candles.filter((c) => c.ts_ms >= savedFromMs && c.ts_ms <= savedToMs);
  const lastInRange = inRange[inRange.length - 1] ?? candles[candles.length - 1];
  if (!lastInRange) return null;
  const savedBars = Math.max(1, inRange.length);
  const endIdx = candles.findIndex((c) => c.ts_ms === lastInRange.ts_ms);
  const anchor = endIdx >= 0
    ? candles[Math.min(candles.length - 1, endIdx + Math.round(savedBars * AFTER_RANGE_RATIO))]
    : lastInRange;
  return {
    rightEdgeMs: anchor.ts_ms,
    barSpan: Math.max(1, Math.min(MAX_LEGIBLE_DAILY_SPAN, Math.round(savedBars * CONTEXT_SPAN_RATIO))),
    atLiveEdge: false,
  };
}

/**
 * 밴드가 쓰는 저장 구간 기술자. 경계는 **저장 구간 안에 실제로 존재하는 캔들의 ts**
 * 로만 잡는다 — D/W/M 의 timeScale 은 하루/한 주/한 달이 1포인트인 캘린더 축이라,
 * 축에 없는 임의 ms 를 좌표로 바꾸면 어긋난다(#1238 이 그 사고였다).
 */
export type StudySavedRangeMarks = {
  fromMs: number;
  toMs: number;
  barCount: number;
};

export function studySavedRangeMarks(
  save: StudyViewReference,
  candles: readonly Candle[],
): StudySavedRangeMarks | null {
  const inRange = candles.filter(
    (c) => c.ts_ms >= save.range.from_ms && c.ts_ms <= save.range.to_ms,
  );
  const first = inRange[0];
  const last = inRange[inRange.length - 1];
  if (!first || !last) return null;
  return {
    fromMs: first.ts_ms,
    toMs: last.ts_ms,
    barCount: inRange.length,
  };
}
