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

/**
 * 소스 스왑 재착석의 목표 논리범위 — 순수(2026-08-24).
 *
 * 캔들 배열이 **통째로 다른 소스의 것으로 갈린** 커밋에서 화면을 다시 앉힌다. lwc 는
 * 이때 "마지막 봉 기준 오프셋"만 보존하므로(2026-08-24 실측: `scrollPosition` 불변),
 * 새 소스의 봉이 적으면 span 이 데이터보다 커져 화면 왼쪽이 통째로 빈다 — 462350
 * 10분봉에서 195봉 → 122봉, 화면이 73봉(≈320px) 미끄러진 것이 그 지문이다.
 *
 * 분기 축은 `computeRestoreRange` 와 같다. **라이브 엣지였는가**:
 *  - 그렇다 → 초기 분봉 배치를 다시 적용한다. `Math.min(totalBars, …)` 클램프가 요점 —
 *    이것만이 "span 이 데이터보다 크다" 를 고칠 수 있고, 재투영으로는 안 된다(그 값은
 *    lwc 가 스스로 착지한 곳과 같아 EPSILON 스킵된다).
 *  - 아니다 → 보던 시각(`anchorIdx`)을 오른쪽 끝에 두고 span 을 데이터로 클램프한다.
 *    앵커가 새 데이터 범위 밖이면 호출자가 lwc 의 findNearest 클램프를 그대로 넘긴다 —
 *    **가장 가까운 데이터가 사라진 캔들보다 낫다**(저장뷰 착석과 같은 판단).
 *
 * `from` 은 항상 `>= 0`: 음수면 왼쪽 여백이 생겨 이 함수가 고치려는 증상이 재발한다.
 */
export function sourceSwapReseatRange(args: {
  /** 스왑 직전 스냅샷이 라이브 엣지였나. */
  atLiveEdge: boolean;
  /** 스왑 직전 화면 폭(논리 바) — 과거 분기의 줌 계승. */
  spanBars: number;
  /** 새 소스의 캔들 수. */
  totalBars: number;
  /** 새 축에서의 마지막 봉 논리 인덱스. */
  latestIdx: number;
  /** 새 축에 재투영한 스냅샷 오른쪽 끝. `null` 이면 라이브 엣지 배치로 폴백. */
  anchorIdx: number | null;
  /** 초기 배치 목표 봉 수(`initialVisibleMinuteBarsFor`). */
  initialVisibleBars: number;
  /** 그 봉 수에 맞는 오른쪽 여백(`minuteRightOffsetBars`). 아래 `savedRightPaddingBars`
   *  가 없을 때만 쓰는 **폴백**이다. */
  rightOffsetBars: number;
  /**
   * 스왑 **직전 화면의** 오른쪽 여백(마지막 봉 뒤 논리 바). 있으면 이것을 그대로 쓴다.
   *
   * 여백을 정책값으로 다시 계산하면 **캔들이 옆으로 밀린다.** 2026-08-24 사용자 보고가
   * 그것이었다: 라이브 엣지에서 토글했는데 여백이 67 → 80 바로 늘어(626px 화면에서
   * ≈30px) 캔들 무리가 왼쪽으로 밀리고 오른쪽이 비었다. 화면에 떠 있던 값은 초기 배치
   * 이후 SSE 성장·리사이즈·lwc 클램프를 거친 것이라 정책 재계산과 일치하지 않는다.
   *
   * span 은 여전히 데이터 크기로 접는다 — 그쪽이 이 재착석의 존재 이유다. 즉 **왼쪽은
   * 정책이, 오른쪽은 화면이** 정한다.
   */
  savedRightPaddingBars?: number | null;
}): { from: number; to: number } {
  const { atLiveEdge, spanBars, totalBars, latestIdx, anchorIdx } = args;
  if (atLiveEdge || anchorIdx === null) {
    const visibleBars = Math.max(1, Math.min(totalBars, args.initialVisibleBars));
    const padding =
      typeof args.savedRightPaddingBars === 'number'
        && Number.isFinite(args.savedRightPaddingBars)
        && args.savedRightPaddingBars >= 0
        ? args.savedRightPaddingBars
        : args.rightOffsetBars;
    return {
      from: Math.max(0, latestIdx + 1 - visibleBars),
      to: latestIdx + 1 + padding,
    };
  }
  const span = Math.max(1, Math.min(Math.round(spanBars), totalBars));
  const to = Math.max(span, anchorIdx);
  return { from: to - span, to };
}
