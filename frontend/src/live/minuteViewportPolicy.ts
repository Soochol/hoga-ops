import { CHART_TIMESCALE_OPTIONS } from '../util/chartScale';

export const MINUTE_RIGHT_LABEL_GUTTER_PX = 180;

export function minuteRightOffsetBars(visibleBars: number, plotWidth: number): number {
  const configured = CHART_TIMESCALE_OPTIONS.rightOffset ?? 0;
  if (plotWidth <= MINUTE_RIGHT_LABEL_GUTTER_PX || visibleBars <= 0) return configured;
  const offsetForLabelGutter = Math.ceil(
    (MINUTE_RIGHT_LABEL_GUTTER_PX * visibleBars) /
      (plotWidth - MINUTE_RIGHT_LABEL_GUTTER_PX),
  );
  return Math.max(configured, offsetForLabelGutter);
}

/** lwc가 한 화면에 표현할 수 있는 최대 논리 span(봉). minBarSpacing이 바닥이다. */
export function maxRenderableSpan(plotWidth: number, minBarSpacing: number): number {
  if (plotWidth <= 0 || minBarSpacing <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(plotWidth / minBarSpacing));
}

/**
 * 분봉 복원 기하 — 저장 span을 현재 차트 폭에서 **실제로 그릴 수 있는** 범위로
 * 접고, 그 결과에 맞는 오른쪽 여백을 계산한다.
 *
 * 왜 필요한가. `minuteRightOffsetBars`는 "180px 거터 = 몇 봉인가"를 정확히 풀지만
 * 입력이 *저장된* span이다. 저장은 넓은 `/live` 화면(예: 1600px)에서 이뤄지고
 * 복원은 좁은 `/study` 차트(예: 750px)에서 일어나므로, 저장 span이 복원 화면의
 * 상한(`plotWidth / minBarSpacing`)을 넘는 일이 흔하다. 그때 여백만 저장 span
 * 기준으로 크게 잡히고 전체 span은 상한으로 잘려, 여백이 가용 폭의 대부분을
 * 차지하고 캔들이 화면 왼쪽으로 밀려난다(실측: 저장 3235봉 → 여백 1022 + 데이터
 * 478). D/W/M 복원은 `maxLegibleSpan`으로 이미 같은 붕괴를 막고 있다 — 이 함수가
 * 분봉 쪽 대칭이다.
 *
 * 반환 span/offset은 항상 `span + offset <= maxRenderableSpan`을 만족한다.
 */
export function minuteRestoreGeometry(
  savedBarSpan: number,
  plotWidth: number,
  minBarSpacing: number,
): { barSpan: number; rightOffset: number } {
  const saved = Math.max(1, Math.round(savedBarSpan));
  const offsetForSaved = minuteRightOffsetBars(saved, plotWidth);
  const maxSpan = maxRenderableSpan(plotWidth, minBarSpacing);
  if (saved + offsetForSaved <= maxSpan) {
    return { barSpan: saved, rightOffset: offsetForSaved };
  }
  // 상한에 걸렸다 — 가용 폭 안에서 거터 비율(180px/plotWidth)을 지키며 재배분한다.
  const gutterRatio =
    plotWidth > MINUTE_RIGHT_LABEL_GUTTER_PX ? MINUTE_RIGHT_LABEL_GUTTER_PX / plotWidth : 0;
  const rightOffset = Math.max(
    CHART_TIMESCALE_OPTIONS.rightOffset ?? 0,
    Math.ceil(maxSpan * gutterRatio),
  );
  return { barSpan: Math.max(1, maxSpan - rightOffset), rightOffset };
}
