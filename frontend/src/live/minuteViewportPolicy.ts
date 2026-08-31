import { CHART_TIMESCALE_OPTIONS } from '../util/chartScale';

export const MINUTE_RIGHT_LABEL_GUTTER_PX = 180;

/** 화면이 이 비율 이하만 데이터면 **사실상 빈 화면**으로 본다.
 *  `useViewportBackfill` 의 3e(빈 화면 클램프 탈출)와 **같은 문턱**이다 — 같은 상태를
 *  두 곳이 다른 값으로 판정하면 「탈출구는 도는데 재투영은 계속 틀리는」 구간이 생긴다. */
const REPROJECTABLE_DATA_RATIO = 0.1;

/**
 * 이 뷰포트가 **재투영을 받을 자격이 있는가**.
 *
 * 리포지셔너(효과 2)의 계약은 「축이 밀린 만큼 화면을 옮겨 **사용자가 보던 봉**을
 * 고정한다」인데, 그 계약은 **화면에 그 봉이 있을 때만** 뜻이 있다. 좌팬으로 데이터
 * 왼쪽 밖까지 나가면 화면은 거의 전부 whitespace 고, 거기엔 고정할 봉이 없다.
 *
 * ## 그 상태에서 재투영이 하는 일이 정확히 사용자가 겪은 버그다
 *
 * 2026-08-26 사용자 로그(010140 3분봉, hogaplay ON, 좌팬):
 *
 * ```
 * shift=640 from=-1586 to=641  seatDrift=765   refIdx=1 onBar=true
 * shift=644 from=-1582 to=645  seatDrift=901   refIdx=1 onBar=true
 * shift=517 from=-1709 to=518  seatDrift=888   refIdx=1 onBar=true
 * …
 * shift=3386 from=1160 to=3387 seatDrift=5155  refIdx=1 onBar=true
 * ```
 *
 * `refIdx=1` 이 매번 반복된다 — 화면 오른쪽 끝이 **데이터의 두 번째 봉**에 붙어 있다는
 * 뜻이고, 스냅샷은 `[-2226, 1]`(2227 바 중 데이터 1 바)이었다. 그 상태에서
 * `shift = newIdx - refIdx` 는 사실상 **프리펜드된 봉 수**가 되고,
 * `to = snap.toLogical + shift = 1 + 프리펜드수` 는 **새로 온 데이터의 오른쪽 끝**이다.
 *
 * 즉 사용자는 「더 과거를 보려고」 빈 곳까지 끌었는데, 재투영이 그 요청으로 도착한
 * 데이터를 **건너뛰고** 화면을 미래로 되돌린다. `seatDrift` 가 765 → 5155 로 **양수만
 * 누적**하는 것이 그 증거다(좌팬은 음수 방향이므로 사용자 입력으로는 설명되지 않는다).
 * 마지막 줄에서 `from` 이 양수로 넘어가는 순간이 화면이 데이터 한복판으로 튀는 순간이다.
 *
 * ## 그래서 자격을 뺀다 — 무엇으로 대체되는가
 *
 * 재투영을 건너뛰면 lightweight-charts 의 setData 재앵커(마지막 봉 기준 오프셋 보존)가
 * 그대로 남고, 프리펜드된 봉들이 화면 왼쪽 whitespace 를 **채운다**. 그것이 좌팬의
 * 원래 의도다. 데이터가 화면을 되찾으면 비율이 문턱을 넘어 재투영이 다시 켜진다.
 *
 * ⚠ **소스 스왑 재착석(`sourceSwapReseatRange`)에는 이 자격 검사가 없다.** 같은 사각이
 * 있을 수 있으나 사용자 로그가 증명한 것은 프리펜드 계열뿐이라 여기서 넓히지 않는다
 * (이 표면이 여섯 번 재작업된 방식이 정확히 그 확대였다).
 *
 * @param fromLogical 스냅샷 화면 왼쪽(논리 바). 데이터 밖이면 음수.
 * @param toLogical   스냅샷 화면 오른쪽(논리 바).
 */
export function viewportHasReprojectableAnchor(
  fromLogical: number,
  toLogical: number,
): boolean {
  const span = toLogical - fromLogical;
  if (!(span > 0)) return false;
  // 화면 안의 **데이터** 폭. 오른쪽 끝마저 0 보다 작으면(화면이 통째로 데이터 왼쪽
  // 밖) 음수가 나오므로 0 으로 접는다 — 접지 않으면 음수 폭이 비율 비교를 통과한다.
  const dataBars = Math.max(0, toLogical - Math.max(fromLogical, 0));
  return dataBars > span * REPROJECTABLE_DATA_RATIO;
}

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
   *
   * ⚠ **계승에는 sanity 상한이 있다 — `max(rightOffsetBars, visibleBars)`.**
   * 이 계약은 "화면에 떠 있던 값 ≈ 정책값 근처" 라는 전제 위에 서 있는데, 그 전제가
   * 깨지는 경로가 실재한다(2026-08-25 실측, 000660 5분봉 장중): 뷰포트가 데이터 우측
   * 수천 바 밖에 좌초하면 그 거리가 lwc 내부 scrollPosition(3,534바)으로 고착되고,
   * 스냅샷은 그것을 '여백'으로 잰다. 무조건 계승하면 재착석이 좌초를 토글 양방향에서
   * 충실히 복제해 **눌러도 눌러도 빈 화면**이 된다. 여백의 의미(가격 라벨 거터)상
   * 화면에 보일 데이터(visibleBars)를 넘는 값은 어떤 정상 상태에서도 나올 수 없으므로,
   * 상한 밖은 오염으로 보고 정책값으로 폴백한다 — 절단(clamp-to-bound)이 아니라
   * 폴백인 이유: 상한 언저리로 자르면 여전히 화면 절반이 빈다. 정상 케이스(67 vs 정책
   * 80)는 상한과 두 자릿수 차이가 나므로 이 판정에 걸리지 않는다.
   */
  savedRightPaddingBars?: number | null;
}): { from: number; to: number } {
  const { atLiveEdge, spanBars, totalBars, latestIdx, anchorIdx } = args;
  if (atLiveEdge || anchorIdx === null) {
    const visibleBars = Math.max(1, Math.min(totalBars, args.initialVisibleBars));
    const maxSanePadding = Math.max(args.rightOffsetBars, visibleBars);
    const padding =
      typeof args.savedRightPaddingBars === 'number'
        && Number.isFinite(args.savedRightPaddingBars)
        && args.savedRightPaddingBars >= 0
        && args.savedRightPaddingBars <= maxSanePadding
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

/**
 * 소스 스왑 재착석이 **어느 앵커로** 앉을지 고른다 — 강제 이동은 사용자의 앵커를
 * 잃게 하지 않는다.
 *
 * 배경: 디스크(2024-08~)와 벤더(250일 롤링)는 데이터 깊이가 다르다. 깊은 과거를 보다
 * 소스를 바꾸면 그 시각이 새 소스에 없어 lwc 가 가장 가까운 봉으로 **강제 클램프**한다
 * (2026-08-26 실측: sp −16,362 → 데이터 맨 앞, 팬 깊이를 바꿔도 항상 같은 값으로 수렴).
 * 그 커밋 이후의 스냅샷은 클램프 착지를 담으므로, 사용자가 되돌아와도(토글-백) 원래
 * 보던 곳이 아니라 **착지점**으로 앉는다 — 왕복이 위치를 잃는 경로다.
 *
 * 그래서 강제 클램프가 일어난 스왑은 **원래 앵커를 따로 보관**하고(`forced`), 다음
 * 스왑에서 이 함수가 둘 중 하나를 고른다:
 *
 *  - `forced` — 사용자가 착지점에서 **움직이지 않았다면**(왕복 의도) 원래 위치로 복원.
 *  - `fresh` — 사용자가 그 사이 **의미 있게 움직였다면**(새 의도) 지금 보는 곳을 승계.
 *
 * "움직였다" 의 판별은 **인덱스 거리**다: 강제 착지 봉과 현재 스냅샷의 오른쪽 끝을
 * **같은 축**(스왑 커밋의 새 축)에 재투영해 화면 폭(`spanBars`) 이내면 안 움직인 것.
 * 시간(ms) 비교를 쓰지 않는 이유: 가상축이 밤·주말을 접으므로 실시간 차이는 세션
 * 거리와 무관하게 폭발한다 — 하루 경계를 살짝 걸친 팬이 "크게 움직였다" 로 오판된다.
 *
 * `freshAtLiveEdge` 는 명시적 의도 신호라 휴리스틱보다 먼저다 — 라이브 엣지로 돌아간
 * 사용자는 복원을 원하지 않는다. 재투영이 실패하면(`null`) 검증 불가이므로 보수적으로
 * `fresh` 다(잘못된 복원 > 복원 없음).
 */
export function pickSwapAnchor(args: {
  /** 보관된 강제-이동 앵커가 있는가. */
  hasForced: boolean;
  /** 현재 스냅샷이 라이브 엣지인가 — 그렇다면 복원하지 않는다(명시적 의도). */
  freshAtLiveEdge: boolean;
  /** 현재 스냅샷 오른쪽 끝을 새 축에 재투영한 인덱스. 실패 시 null. */
  freshIdx: number | null;
  /** 강제 착지 봉을 같은 축에 재투영한 인덱스. 실패 시 null. */
  landedIdx: number | null;
  /** 현재 스냅샷의 화면 폭(논리 바) — "안 움직였다" 의 허용 반경. */
  spanBars: number;
}): 'fresh' | 'forced' {
  if (!args.hasForced) return 'fresh';
  if (args.freshAtLiveEdge) return 'fresh';
  if (args.freshIdx === null || args.landedIdx === null) return 'fresh';
  return Math.abs(args.freshIdx - args.landedIdx) <= args.spanBars ? 'forced' : 'fresh';
}

