// 최대벽 강도 pane 의 **모드별 점 선택** — 표현 모드 분기(순수).
//
// `LiveChartRoot` 안의 인라인 분기였는데 **테스트가 원리적으로 닿지 않았다**: 그 분기를
// 통째로 지워도 프론트 전 스위트가 초록이었다(실측 2026-09-05, red-check). pane 이
// 답하는 질문을 바꾸는 자리라 가드가 없으면 안 되므로 순수 함수로 뺀다.
//
// **체결·전체 두 계열이 여기를 지난다.** 미도달만 오지 않는다 — 그 계열은 판정이 하루
// 스코프라 소급 재분류되어, 봉별로 그리면 과거 봉의 값이 장중에 나타났다 사라진다.
// (전체 계열은 2026-09-05 에 뒤늦게 합류했다: 처음엔 "가장 크게 **체결된**" 이라는 문구
// 때문에 제외했는데, 사용자가 같은 날 확장을 요청했다 — ADR-0171 amendment.)

import type { AskPeakCandidate, Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { PeakWallSegment } from '../chart/PeakWallSegmentsPrimitive';
import {
  buildPeakWallBarPoints,
  buildPeakWallStepPoints,
  type PeakWallStepPoint,
} from '../chart/peakWallSteps';
import type { PeakWallPaneMode } from '../state/liveIndicatorsPersistence';

/** pane 이 꺼졌거나 입력이 빈 상태의 **공유** 빈 배열 — 매번 새 `[]` 를 만들면 발행
 *  훅의 "점 배열이 그대로면 쓰지 않는다" 조건이 무력해진다(그게 좌팬 중 "Maximum
 *  update depth exceeded" 의 연료였다 — `usePeakWallStepsPublisher` 머리말). */
export const EMPTY_PEAK_WALL_STEPS: readonly PeakWallStepPoint[] = [];

/**
 * 한 계열의 pane 점 — 모드에 따라 누적 계단 또는 봉별.
 *
 * ⚠ `bar` 모드에서 후보가 없으면 **계단으로 떨어지지 않는다**. 폴백하면 모드를
 * 바꿨는데 같은 그림이 나와 "안 먹었다" 로 읽히고, 실제로 그 상태는 "이 창은 봉별
 * 데이터를 안 받았다"(옵트인 미요청·구백엔드·과거 캐시)라 빈 pane 이 정직하다.
 */
export function buildBarModePanePoints(args: {
  mode: PeakWallPaneMode;
  /** pane 마스터 — 꺼져 있으면 어느 모드든 계산하지 않는다. */
  paneEnabled: boolean;
  /** 봉별 모드 입력(필터 우회 — `usePeakWallRender.barCandidates`). */
  barCandidates: readonly AskPeakCandidate[];
  /** 누적 모드 입력(필터를 통과한 세그먼트). */
  stepSegments: readonly PeakWallSegment[];
  candles: readonly Candle[];
  axis: VirtualAxis;
  color: string;
}): readonly PeakWallStepPoint[] {
  const { mode, paneEnabled, barCandidates, stepSegments, candles, axis, color } = args;
  if (!paneEnabled) return EMPTY_PEAK_WALL_STEPS;
  if (mode === 'bar') {
    return barCandidates.length > 0
      ? buildPeakWallBarPoints(barCandidates, candles, axis, color)
      : EMPTY_PEAK_WALL_STEPS;
  }
  return stepSegments.length > 0
    ? buildPeakWallStepPoints(stepSegments, candles, axis, color)
    : EMPTY_PEAK_WALL_STEPS;
}
