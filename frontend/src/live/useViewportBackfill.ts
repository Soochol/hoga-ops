import { useEffect, useLayoutEffect, useRef } from 'react';
import type { IChartApi, Time } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import type { RangeBundle } from '../api/types';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import type { LiveVenueOption } from '../state/liveVenue';
import { initialVisibleMinuteBarsFor } from './liveVenuePolicy';
import { minuteRightOffsetBars, sourceSwapReseatRange } from './minuteViewportPolicy';
import { realMsToVirtualSeconds } from './viewportAnchor';
import { useHistoricalRangeActions, useWindowViewGuard } from './workspace/windowView';
import {
  nextHistoricalFrom,
  nextCoverageFrom,
  planFillStep,
  planViewportContraction,
  planSourceSwapContraction,
  fillBudgetSteps,
  dispatchStepsFor,
  realMsToYyyymmdd,
} from './liveDateTime';
import { livePerfLog } from '../util/perfDebug';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';

/** viewport 좌단 가시 바의 KST 날짜(YYYYMMDD). getVisibleRange().from(virtual sec)를
 * axis.toReal로 실시간 ms 변환 — coverage-gap 판정용. 측정 불가 시 null. */
function readViewportLeftDate(chart: IChartApi, axis: VirtualAxis): string | null {
  try {
    const vr = chart.timeScale().getVisibleRange();
    if (!vr) return null;
    return realMsToYyyymmdd(axis.toReal((vr.from as number) * 1000));
  } catch {
    return null;
  }
}

/** fill 스텝 수 상한. left_pan은 제스처 예산(fillBudgetSteps)이 이 값으로
 * 캡되고, coverage_gap은 날짜 수렴이 주 종료 조건이라 이 값이 백스톱 예산이
 * 된다. 분봉 250일 클램프·D/W/M 데이터 고갈이 보통 먼저 멈춘다. */
const MAX_FILL_STEPS = 60;

/** 화면에서 데이터가 이 비율 이하만 덮으면 **사실상 빈 화면**으로 본다(3e 판정).
 *
 * `logical.from < 0` 만으로는 안 된다 — 정상 좌팬도 매 이벤트에서 음수를 보고하고,
 * 그건 3b 가 이미 처리한다. 3e 가 노리는 것은 **화면이 통째로 whitespace 인데
 * 아무도 안 채우고 있는** 상태다(실측 클램프: span 402 중 데이터 1바 = 0.25%).
 * 0.1 은 그 둘 사이를 넉넉히 가르는 값이고, 위로 틀리면 3e 가 덜 발화할 뿐이라
 * 안전 방향이다(3b 가 여전히 정상 경로를 쥔다). */
const EMPTY_VIEWPORT_DATA_RATIO = 0.1;

/** 3e 가 한 클램프 구간에서 자동으로 이어붙일 수 있는 스텝 수 상한.
 *
 * ⚠ **디스크 모드(hogaplay ON)에는 좌측 바닥이 없다** — `minuteScrollbackFloorDate`
 * 가 `restBypassEnabled` 에서 `null` 이라 `planFillStep` 의 `earliestAllowedDate`
 * stop 이 절대 안 걸리고, `extendHistoricalRange` 도 단조 감소 가드만 있지 하한을
 * 모른다. 즉 **종료를 보장하는 것은 이 상수뿐이다.**
 *
 * 3 인 근거: 예산 추정(`fillBudgetSteps`)이 빗나가는 정상 사례는 1~2 스텝이면
 * 흡수된다. 그보다 길게 이어져야 하는 구간은 데이터가 원래 없는 곳이므로, 자동으로
 * 계속 파고드는 것보다 **멈추고 사용자 조작을 기다리는 편**이 낫다(그 조작이 곧
 * 뷰포트 이벤트라 3b 가 정상적으로 이어받는다). */
const MAX_CLAMP_RECOVERY_STEPS = 3;

/** coverage_gap 트리거 판정(3b lazy-fetch·3c 초기표시 공유). viewport 좌단 가시
 * 날짜가 활성 range 지표 커버리지(coverageFrom)보다 과거면 range 창을 그 좌단까지
 * 당기는 확장 계획을 반환, 아니면 null. window-base nextCoverageFrom 을 쓴다 —
 * 캔들은 병합 캐시로 복원됐으니 axis-base 로 확장하면 폭발한다. 목표(coverageTarget)는
 * 트리거 순간의 좌단 날짜라 캔들 전체 범위를 따라잡지 않는다(#582 wide-range 재발 방지). */
function planCoverageGapFill(
  chart: IChartApi,
  axis: VirtualAxis,
  timeframe: LiveTimeframe,
  historicalFromDate: string | null,
  coverageFrom: string | null,
  windowFrom: string | null,
): { nextFrom: string; coverageTarget: string } | null {
  if (coverageFrom === null || windowFrom === null) return null;
  const leftDate = readViewportLeftDate(chart, axis);
  if (leftDate === null || leftDate >= coverageFrom) return null;
  return {
    nextFrom: nextCoverageFrom(historicalFromDate, windowFrom, timeframe),
    coverageTarget: leftDate,
  };
}

/** 재배치 skip 허용 오차(논리 인덱스). lwc가 스스로 타깃에 착지한 경우(라이브
 * 엣지 보존) 중복 set으로 한 프레임 플래시를 만들지 않기 위한 게이트. */
const REPOSITION_EPSILON = 0.5;

export interface ViewportBackfillArgs {
  chart: IChartApi | null;
  axis: VirtualAxis;
  bundle: RangeBundle | null;
  timeframe: LiveTimeframe;
  /** 초기 분봉 배치 재적용(소스 스왑 재착석)이 쓰는 거래소. 배치 정책의 인자다. */
  venue?: LiveVenueOption;
  /** useLiveBundle.isExtending. false-edge = 한 스텝 settle. */
  isExtending: boolean;
  /** Reset key — per-code state (snapshot, fill-step counter) clears on switch. */
  code: string;
  /**
   * 캔들 소스 축(`useLiveBundle.candleSourceKey`) — 값이 갈리면 **소스 스왑 재착석**이
   * 발화한다. 미지정이면 재착석이 꺼진다(축이 없는 호출자는 종전 동작).
   *
   * ## 왜 별도 경로인가 — 리포지셔너로는 못 고친다
   *
   * 리포지셔너의 계약은 "**같은 봉**을 화면에 유지"(refMs 재투영)인데, 소스가 갈리면
   * 그 봉이 새 소스에 **없을 수 있다**. 2026-08-24 실측(462350, 10분봉): 벤더 195봉 →
   * 디스크 122봉(08-21·08-24 미캡처). 라이브 엣지의 refMs 를 새 축에 재투영하면 lwc 가
   * 스스로 착지한 `[-73, 161]` 과 **정확히 같은 값**이 나와 EPSILON 스킵된다 — 즉
   * 재투영만으로는 아무것도 바뀌지 않는다. 문제는 위치가 아니라 **span(234)이 데이터
   * (122봉)보다 크다**는 것이고, 그건 초기 배치 정책만이 아는 사실이다.
   *
   * 그래서 재착석은 `computeRestoreRange` 와 **같은 축으로 갈린다**:
   *  - 라이브 엣지였다 → 초기 분봉 배치를 다시 적용(`initialVisibleMinuteBarsFor` +
   *    `minuteRightOffsetBars`). span 이 데이터 크기로 클램프되는 것이 요점이다.
   *  - 과거를 보고 있었다 → refMs 앵커를 오른쪽 끝에 두고 span 을 데이터로 클램프.
   *
   * ⚠ **키만 보고 움직이면 안 된다.** 토글은 즉시 키를 뒤집지만 디스크 응답은 콜드에서
   * 십수 초 뒤에 온다(실측 11.6s). 그 사이 커밋들의 캔들은 아직 **옛 소스의 것**이라
   * 그때 앉히면 곧 도착할 데이터가 다시 화면을 밀어낸다. 그래서 판정이 두 항의 AND 다:
   * **키가 갈렸다** AND **캔들 배열의 정체성(개수·최초 ts)이 갈렸다**.
   */
  candleSourceKey?: string;
  /** Backfill must not race the initial live-edge viewport placement. */
  canTriggerBackfill?: () => boolean;
  /** Coverage-gap 백필(A안): 활성 range 지표(hoga/sidecar)가 도달한 가장 최근 from_date.
   * 캔들이 병합 캐시로 더 과거까지 복원돼도 지표가 이 날짜까지만 있으면, viewport 좌단이
   * 이보다 과거일 때 whitespace 없이도 range 창을 확장한다. 분봉 외/미로드면 null → 비활성. */
  indicatorCoverageFromDate?: string | null;
  /** 지금 range가 요청 중인 창의 from — nextCoverageFrom base의 null-fallback. */
  rangeWindowFromDate?: string | null;
  /**
   * 지금 **서빙 중인** 과거 캔들 창의 from(YYYYMMDD) — 응답이 되싣는 echo.
   *
   * 진행 루프(3a)의 두 번째 스텝-완료 신호다. 첫 번째(isExtending 하강 엣지)는 fetch가
   * 있어야만 성립하는데, 웜 캐시 히트는 fetch 없이 스텝을 완결시킨다 — 그때 이 값이
   * 요청한 from과 같아지는 것이 유일한 진행 증거다. 지원하지 않는 경로는 null(비활성).
   *
   * **최좌단 캔들 날짜로 대체하지 말 것.** 연휴만 든 청크·상장일 도달 청크는 새 캔들이
   * 0개여도 요청한 from을 그대로 되싣는다. 응답 echo를 봐야 그런 스텝도 예산을 소모하고
   * 루프가 이어진다 — `planFillStep`의 "연휴 스텝도 예산 1" 계약이 여기에 기댄다.
   */
  settledFromDate?: string | null;
  /**
   * 열린 저장뷰의 **구간 시작일**(YYYYMMDD). null = 저장뷰 없음.
   *
   * 저장뷰 적용은 팬 없이 순간 이동하므로 3b(좌측 팬 이벤트)가 발화하지 않고, 단발
   * `extend` 는 fill 을 **시작하지 않아**(fillKind 가 null 이면 3a 가 곧바로 return)
   * 한 스텝에서 멎는다 — 2026-08-21 실측: 3개월 전 저장뷰가 3분 20초를 기다려도
   * 오늘 화면 그대로였다. 그래서 3d 가 3c 와 같은 방식으로 fill 을 세운다.
   */
  savedRangeFromDate?: string | null;
  /**
   * 좌측 팬의 하한(YYYYMMDD) — `useLiveBundle.minuteScrollbackFloorDate`. `null` = 무한.
   *
   * **판정을 여기서 하지 않고 받는다.** 종전엔 이 훅이 세 자리에서
   * `earliestAllowedMinuteDate(todayKstYyyymmdd())` 를 직접 불렀는데, 그건 **벤더
   * 엔드포인트의 span 캡**(250일)이라 디스크를 읽는 창에는 근거가 없다. 하한이 모드에
   * 따라 갈리는 값이 된 이상 판정은 모드를 아는 쪽(`useLiveBundle`)이 해야 한다:
   * 벤더 모드=250일 벽, 디스크 모드=응답이 증명한 캡처 바닥(증명 전에는 `null` → 계속 팬).
   *
   * ⚠ **이 이관이 저장뷰를 고치는 것은 아니다.** 얼린 창은 `canTriggerBackfill` 이
   * 백필 4경로를 통째로 끄고(`savedRangeFrozen`), 캘린더 봉 저장뷰는 애초에 하한이
   * `null` 이라 종전에도 벽에 안 걸렸다. 벽이 실제로 걸리던 자리는 **저장뷰 종목이
   * 아닌 분봉 창**(같은 기간만 함께 보는 창)인데, 그 창은 벤더를 읽으므로 벽이 옳다.
   * 즉 여기서 바뀌는 것은 **그 창이 디스크 모드일 때뿐**이다.
   *
   * 미지정이면 `null`(무한)이다. `/study` 가 그 경로였는데 무해했다 — 그 페이지는
   * `historicalFromDate` 를 소비하는 쿼리가 없어 백필이 **inert**(fetch 0)였다
   * (2026-08-23 페이지 삭제로 이 경로의 소비자는 없다).
   */
  minuteScrollbackFloorDate?: string | null;
  /**
   * 이 창에 걸린 **기간 점프**의 목적지(YYYYMMDD). null = 점프 없음.
   *
   * 저장뷰와 **정확히 같은 문제**라 3d 가 둘을 함께 받는다: 순간 이동이라 팬
   * 이벤트가 없어 3b 가 발화하지 않고, 단발 `extend` 는 한 청크에서 멎는다. 둘 중
   * 더 과거를 목표로 삼아 한 번에 워크백한다 — 저장뷰를 연 채로 점프하면 두 구간이
   * 모두 필요하고, 목표를 하나만 두면 나머지가 영영 안 채워진다.
   *
   * ⚠ **게이트를 통과한 값이어야 한다.** 스토어의 원시 점프 슬롯을 그대로 물리면
   * 창번호·종목이 달라 **받지도 않은** 점프를 위해 과거를 긁는 창이 생긴다
   * (`useTimeframeJump.backfillFromDate` 가 그 게이트를 통과한 결과다).
   */
  jumpFromDate?: string | null;
}

/** Headless controller for /live's leftward-pan historical backfill +
 * staleness-free viewport repositioning. Three effects:
 *   1. pre-swap snapshot (useLayoutEffect) — records the view in the SAME
 *      commit as a bundle swap, before any setData runs.
 *   2. repositioner — after the prepend's setData, pins the snapshot's bars
 *      back on screen (skip when lwc already landed there).
 *   3. lazy-fetch trigger + progressive settle-loop — dispatch fetches when
 *      the user pans past the leftmost loaded bar.
 *
 * VIEWPORT CONTRACT (v3, /diagnose 2026-06-05 ×2): a historical prepend keeps
 * the SAME BARS on screen, and the reposition target is computed from the view
 * AS OF THE PREPEND COMMIT — never from a position captured earlier.
 *
 * Why app-side repositioning is needed at all — lwc 5.2.0's own setData
 * re-anchor is position-DEPENDENT (measured in-browser, stack-attributed
 * monkey-patch on every timeScale viewport API, real synthetic-mouse drags):
 *   ① view at the live edge → preserved exactly (repositioner skips);
 *   ② view deep in left whitespace → lands near the new/old data seam;
 *   ③ view mid-data → logical indices FROZEN, the content slides by the
 *     inserted count — a days-scale teleport (reproduced on the user's build:
 *     [598,1561] byte-identical across a 4-day prepend, content 04-20→04-14).
 *
 * Why the snapshot lives in a LAYOUT effect — the entire bug saga was ONE
 * mistake: capturing the anchor at the FETCH TRIGGER and applying it at the
 * PREPEND. The chart moves in between (the user keeps dragging / pans back /
 * kinetic settle), so the re-assert teleported (±30-bar wobble fresh,
 * thousands of bars stale). Layout effects run before ALL passive effects in
 * the same commit — `RangeSeriesPane`'s setData is a passive useEffect — so a
 * parent useLayoutEffect snapshot is taken after every user input but before
 * the data mutates: the staleness window is structurally zero. The chart still
 * holds the PREVIOUS bundle's data during the layout phase, so the snapshot's
 * right edge converts through the PREVIOUS axis (prevAxisRef), and the
 * repositioner re-projects it through the new axis (timeToIndex on the rebuilt
 * union scale — data-based, works with the reference bar off-screen).
 *
 * Test surface: `LiveChartRoot`'s lwc mock locks the call contract (reposition
 * target, staleness-freedom, live-edge skip). The mock's setData is a no-op,
 * so the rendered-pixels half is browser-only evidence (diagnose notes). */
export function useViewportBackfill({
  chart,
  axis,
  bundle,
  timeframe,
  venue = 'KRX',
  isExtending,
  code,
  candleSourceKey,
  canTriggerBackfill = () => true,
  indicatorCoverageFromDate = null,
  rangeWindowFromDate = null,
  settledFromDate = null,
  savedRangeFromDate = null,
  minuteScrollbackFloorDate = null,
  jumpFromDate = null,
}: ViewportBackfillArgs): void {
  // 창-스코프 절단(ADR-0119 C2c-2a): from-date 읽기/확장은 창 런타임(Provider
  // 안) 또는 전역 스토어(밖)로 — getState 병행 경로의 창별 대응물.
  const historicalRange = useHistoricalRangeActions();
  // 디바운스 발화 시점의 fresh 뷰 가드 — 호출 시점 getState(스토어 직독).
  const viewGuard = useWindowViewGuard();

  // Pre-swap snapshot: the view as of the CURRENT commit's layout phase, with
  // the right edge resolved to real ms through the axis the chart was actually
  // drawn with (prevAxisRef). prevEarliestTsMsRef detects a genuine prepend.
  const preSwapRef = useRef<
    {
      fromLogical: number;
      toLogical: number;
      refMs: number;
      refIdx: number;
      /** 스냅샷 시점에 라이브 엣지에 있었나 — 소스 스왑 재착석의 분기 축.
       *  판정식은 `viewportFromRanges` 와 같다(오른쪽 끝이 마지막 봉의 1초 이내). */
      atLiveEdge: boolean;
      /** 마지막 봉 뒤의 오른쪽 여백(논리 바). 재착석이 **그대로 재사용**한다 —
       *  정책값으로 다시 계산하면 캔들이 옆으로 밀린다(`sourceSwapReseatRange` 의
       *  `savedRightPaddingBars` 도크스트링에 실측). 못 재면 `null`. */
      rightPaddingBars: number | null;
    } | null
  >(null);
  const prevAxisRef = useRef<VirtualAxis | null>(null);
  const prevEarliestTsMsRef = useRef<number | null>(null);
  /** 직전 커밋 번들의 마지막 캔들 ms — **차트에 실제로 그려진** 데이터의 라이브 엣지다.
   *  layout 단계의 `bundle` 은 이미 새 것이라 그것으로 재면 스왑 커밋에서 판정이 뒤집힌다. */
  const prevLastCandleMsRef = useRef<number | null>(null);
  /** 소스 스왑 대기 — 키가 갈린 커밋에서 서고, 캔들 정체성이 갈린 첫 커밋에서 내린다. */
  const swapPendingRef = useRef(false);
  const prevSourceKeyRef = useRef<string | null>(null);
  /** `${개수}|${최초 ts_ms}` — SSE 성장(마지막 봉만 변화)과 소스 교체를 가르는 지문. */
  const prevCandleIdentityRef = useRef<string | null>(null);
  /** 직전 커밋 캔들 배열의 모양 — **중간 삽입**(디스크 구멍의 키움 보충)을 가른다.
   *  프리펜드는 `firstMs` 가, SSE 성장은 `lastMs` 가 움직이므로 셋을 다 봐야 구분된다. */
  const prevCandleShapeRef = useRef<{ count: number; firstMs: number; lastMs: number } | null>(null);
  // 진행 루프: 현재 fill에서 dispatch한 스텝 수 + isExtending 직전값(falling edge 검출).
  const fillStepCountRef = useRef(0);
  const prevExtendingRef = useRef(false);
  // 이미 진행 처리한 스텝의 from. 두 스텝-완료 신호(fetch 하강 엣지 / 캐시 settle)가
  // 같은 스텝에 겹쳐도 예산을 한 단위만 소모하게 하는 멱등 가드다 — 겹치면 fill이
  // 동결 예산을 초과해 목표보다 과거까지 걸어간다.
  const lastAdvancedFromRef = useRef<string | null>(null);
  // 제스처 예산 fill 상태(/investigate 2026-07-11). 트리거(3b) 순간의 빈공간으로
  // 예산을 동결하고, 진행 루프(3a)는 뷰포트를 다시 측정하지 않은 채 예산만
  // 소진하며 무조건 완주한다 — fill 도중의 인터랙션은 이번 fill을 늘리지도
  // 줄이지도 못한다(추가 호출 0). fillKindRef=null이 "활성 fill 없음"이며,
  // 활성 중에는 3b가 새 트리거를 거부해 예산 덮어쓰기를 막는다.
  const fillKindRef = useRef<'left_pan' | 'coverage_gap' | null>(null);
  const fillBudgetRef = useRef(0);
  const fillCoverageTargetRef = useRef<string | null>(null);
  // 초기 표시 coverage_gap 판정을 (code, timeframe)당 1회로 제한하는 래치. 저장
  // 뷰포트가 처음부터 지표 커버리지 밖 과거를 보고 있으면 사용자 무조작으로도 갭을
  // 메우되, 지표 신호가 유효해진 첫 커밋에서 단 한 번만 판정한다(effect 3c).
  const initialCoverageCheckedRef = useRef(false);
  /** 3d 가 fill 을 세운 (저장 구간 시작일 · 점프 목적지) 쌍 — 같은 요청으로 반복
   *  판정하지 않기 위한 키. **쌍이어야 한다**: 한쪽만 키로 두면 다른 쪽이 바뀌어도
   *  마킹이 걸린 채라 그 요청이 조용히 무시된다. */
  const targetFilledForRef = useRef<string | null>(null);
  /** 3e 가 이번 클램프 구간에서 이어붙인 스텝 수. 화면이 다시 채워지면 0 으로 돌아간다
   *  — 그 복귀가 곧 "이 구간은 끝났다" 는 신호다. */
  const clampRecoveryStepsRef = useRef(0);
  /** 3e 가 마지막으로 확장을 건 시점의 `historicalFromDate`. 창이 그대로면(단조 감소
   *  가드에 막혔거나 바닥) 같은 커밋을 반복해도 다시 밀지 않는다. */
  const clampLastFromRef = useRef<string | null>(null);
  // Candle count of the CURRENT render, mirrored into a ref so the lazy-fetch
  // trigger (3b) and settle-loop (3a) can read it without `bundle` in their
  // deps (3b would re-subscribe every SSE tick). NEITHER may run before the
  // first candle has loaded: a still-empty chart reports a NEGATIVE visible
  // logical `from` (no bars to clamp the origin against), which 3b misreads as
  // "user panned past the leftmost bar" and auto-extends historicalFromDate one
  // chunk per render all the way to the 250-day clamp — firing ~50 re-keyed
  // past-candles requests that, for an uncached code, never settle, so the
  // chart stays blank forever (/diagnose 2026-06-09). Effect 2 (reposition)
  // already guards `candles.length === 0`; this brings 3a/3b to parity.
  const candleCountRef = useRef(0);
  candleCountRef.current = bundle ? bundle.candles.length : 0;
  // Backpressure mirror: is a historical extension step already in flight. The
  // lazy-fetch trigger (3b) reads this to cap the outstanding step depth at 1 —
  // rapid zoom-out (e.g. 10× at 500ms defeats 3b's 150ms debounce) must NOT
  // race the fetch pipeline one chunk deeper per event, monotonically driving
  // historicalFromDate toward the 250-day clamp faster than data arrives (the
  // "silent for minutes, then one giant paint" regression, reproduced
  // 2026-07-09). Skipped demand is not lost: the settle-loop (3a) re-reads the
  // live viewport on each extending falling-edge and dispatches the next step
  // itself if whitespace remains — so backpressure delegates queueing to 3a's
  // pull loop. Mirrored to a ref (not an effect dep) so 3b does not re-subscribe
  // every SSE tick (same rationale as candleCountRef above).
  const isExtendingRef = useRef(false);
  isExtendingRef.current = isExtending;
  /** 가장 최근 논리범위 이벤트의 from. 3b 디바운스의 발화 시점 재검증용 — 트림/프리펜드
   *  커밋 중 lwc 과도 이벤트(from<0)가 타이머를 무장시켜도, 리포지셔너의 보정 set 이 내는
   *  후속 이벤트(from≥0)가 이 값을 덮어써 발화가 반려된다(디바운스 arming 분기 주석 참조). */
  const latestLogicalFromRef = useRef<number | null>(null);
  // Coverage-gap 신호 미러. 3b 구독 effect의 deps에 넣지 않으려는 목적 —
  // indicatorCoverageFromDate는 좌측 팬 확장 때만 바뀌지만(SSE 틱은 from_date 불변),
  // deps에 두면 번들 참조 churn 시 재구독 위험이 있어 candleCountRef 패턴을 따른다.
  const coverageFromRef = useRef<string | null>(null);
  coverageFromRef.current = indicatorCoverageFromDate;
  const rangeWindowFromRef = useRef<string | null>(null);
  rangeWindowFromRef.current = rangeWindowFromDate;

  useEffect(() => {
    preSwapRef.current = null;
    prevAxisRef.current = null;
    prevEarliestTsMsRef.current = null;
    prevLastCandleMsRef.current = null;
    swapPendingRef.current = false;
    prevCandleIdentityRef.current = null;
    prevCandleShapeRef.current = null;
    // ⚠ `prevSourceKeyRef` 는 **일부러 리셋하지 않는다.** 여기서 null 로 만들면 1b 가
    // 다음 소스 변경을 첫 관측으로 오인해 래치를 세우지 못한다 — 1b 의 deps 는
    // `[candleSourceKey]` 라 봉·종목 전환만으로는 재실행되지 않아 null 이 그대로 남기
    // 때문이다. 2026-08-24 실측이 그 구멍이었다: 새로고침 직후 토글은 고쳐졌는데
    // **봉을 바꾼 뒤 토글하면** 종전 증상이 그대로였다(`lr [-73,161]`).
    // 소스 축의 값은 `'disk' | 'vendor'` 둘뿐이라 종목·봉을 건너 살아남아도 stale 이
    // 될 수 없다 — 다음 커밋의 1b 가 현재 값과 비교할 뿐이다.
    fillStepCountRef.current = 0;
    prevExtendingRef.current = false;
    lastAdvancedFromRef.current = null;
    fillKindRef.current = null;
    fillBudgetRef.current = 0;
    fillCoverageTargetRef.current = null;
    initialCoverageCheckedRef.current = false;
    latestLogicalFromRef.current = null;
  }, [code, timeframe]);

  // 1. Pre-swap snapshot. Runs in the layout phase of every bundle/axis
  // commit — after the user's last input, before RangeSeriesPane's passive
  // setData mutates the chart. getVisibleRange() therefore returns virtual
  // times in the PREVIOUS axis's coordinate system (the data on screen is
  // still the previous bundle's), which prevAxisRef converts to real ms.
  useLayoutEffect(() => {
    if (!chart) {
      preSwapRef.current = null;
      prevAxisRef.current = null;
      return;
    }
    const ts = chart.timeScale();
    const prevAxis = prevAxisRef.current;
    // 차트에 **그려져 있는** 데이터의 라이브 엣지. 아래 `prevLastCandleMsRef` 대입보다
    // 먼저 읽어야 직전 커밋 값이다 — `prevAxisRef` 와 같은 순서 계약.
    const drawnLastCandleMs = prevLastCandleMsRef.current;
    try {
      const lr = ts.getVisibleLogicalRange();
      const vr = ts.getVisibleRange();
      const refIdx = vr ? ts.timeToIndex(vr.to as Time, true) : null;
      preSwapRef.current =
        lr && vr && refIdx !== null && prevAxis && prevAxis.segments.length > 0
          ? (() => {
              const refMs = prevAxis.toReal((vr.to as number) * 1000);
              // 여백은 **그리던 축**으로 잰다 — 마지막 봉의 논리 인덱스가 그 축에서만
              // 유효하다. `viewportFromRanges` 의 `rightPaddingBars` 와 같은 식이다.
              let rightPaddingBars: number | null = null;
              if (drawnLastCandleMs !== null) {
                const lastIdx = ts.timeToIndex(
                  realMsToVirtualSeconds(prevAxis, drawnLastCandleMs) as Time,
                  true,
                );
                if (typeof lastIdx === 'number' && Number.isFinite(lastIdx)) {
                  const padding = lr.to - (lastIdx + 1);
                  if (padding >= 0) rightPaddingBars = padding;
                }
              }
              return {
                fromLogical: lr.from,
                toLogical: lr.to,
                refMs,
                refIdx,
                // `viewportFromRanges` 와 같은 1초 허용오차 — toReal 왕복 오차를 먹는다.
                atLiveEdge: drawnLastCandleMs !== null && refMs >= drawnLastCandleMs - 1000,
                rightPaddingBars,
              };
            })()
          : null;
    } catch {
      preSwapRef.current = null;
    }
    prevAxisRef.current = axis;
    const candles = bundle?.candles;
    prevLastCandleMsRef.current = candles && candles.length > 0
      ? candles[candles.length - 1].ts_ms
      : null;
  }, [chart, bundle, axis]);

  // 1b. 소스 스왑 대기 래치 + **뷰포트 기준 창 축소**. 키는 데이터보다 **먼저**
  // 바뀌므로(콜드 실측 11.6s) 여기서는 대기만 세우고, 실제 재착석은 효과 2가 캔들
  // 정체성 변화를 확인한 커밋에서 한다.
  //
  // 창 축소(2026-08-25): 토글이 이전 소스가 벌어놓은 깊은 창을 상속하면 새 소스가
  // 그것을 콜드로 전량 재취득한다(실측 55거래일 = 7일 타일 11개 × 모드 2~3종 직렬
  // = 수십 초). 키가 갈리는 커밋의 차트는 아직 옛 소스를 그리고 있으므로 그 뷰포트가
  // "사용자가 보고 있는 것"이고, 창을 그 기준으로 당긴다 — 깊이는 이후 좌측 팬(3b)이
  // 지연 로딩으로 번다. 판정은 `planSourceSwapContraction`(커널, 테이블 테스트)이
  // 쥔다: 뷰포트보다 얕게 자르지 않고, 전진 방향만, 분봉 전용.
  //
  // 이 dispatch 는 렌더 뒤 passive effect 라 키 플립 커밋의 첫 타일 요청 하나는
  // 깊은 창 기준으로 나갈 수 있다 — 워크백이 타일 단위 직렬이라 낭비 상한이 타일
  // 하나이고, 다음 커밋부터 축소된 창으로 계획이 다시 선다.
  useEffect(() => {
    if (candleSourceKey === undefined) {
      // 이 조기 반환이 서면 **1b 전체가 무력**이다 — 래치도 창 축소도 안 돌고,
      // 그래서 2a 재착석이 애초에 존재하지 않게 된다. 소비자가 이 prop 을 안 넘기면
      // 조용히 그렇게 되므로(optional prop) 그 사실을 말하게 한다.
      livePerfLog('viewport_source_key', { code, timeframe, reason: 'prop_undefined' });
      return;
    }
    // **래치 자체의 관측** — 2a 의 반려 로그는 이 래치가 선 뒤에만 찍히므로, 래치가
    // 애초에 안 서면 재착석 계열 전체가 완전 침묵이다. 그 침묵이 "재착석이 실패했다"
    // 로 오독되면 엉뚱한 곳을 고치게 된다. 키가 실제로 갈렸는지를 값으로 남긴다.
    if (prevSourceKeyRef.current !== candleSourceKey) {
      livePerfLog('viewport_source_key', {
        code,
        timeframe,
        prev: prevSourceKeyRef.current,
        next: candleSourceKey,
        latched: prevSourceKeyRef.current !== null,
      });
    }
    if (prevSourceKeyRef.current !== null && prevSourceKeyRef.current !== candleSourceKey) {
      swapPendingRef.current = true;
      if (chart && axis.segments.length > 0 && canTriggerBackfill()) {
        const leftDate = readViewportLeftDate(chart, axis);
        const cur = historicalRange.snapshot().historicalFromDate;
        const contractTo = leftDate
          ? planSourceSwapContraction(cur, leftDate, timeframe)
          : null;
        if (contractTo !== null) {
          livePerfLog('viewport_backfill_contract', {
            code, timeframe, trigger: 'source_swap', from: cur, contractTo, leftDate,
          });
          historicalRange.contract(contractTo);
        }
      }
    }
    prevSourceKeyRef.current = candleSourceKey;
    // 키 이외의 deps 는 prevSourceKeyRef 가드로 no-op — 재실행은 관측일 뿐이다.
  }, [candleSourceKey, chart, axis, timeframe, canTriggerBackfill, historicalRange, code]);

  // 2. Repositioner. Runs after the child setData in the same commit. Three
  // mutations reposition — leftward extension (prepend), mid-array insertion
  // (2b), and left trim (2c, contraction) — because each remaps the union
  // index space. Initial paint and SSE growth are owned by LiveChartRoot's
  // initial-view effect (mutually exclusive via historicalFromDate), and
  // holiday-only chunks change nothing on screen.
  useEffect(() => {
    if (!chart || !bundle || bundle.candles.length === 0) return;
    const ts = chart.timeScale();
    const candles = bundle.candles;
    /** 소스 스왑 재착석 — 적용했으면 true(호출자가 리포지셔너를 건너뛴다). */
    function reseatAfterSourceSwap(snap: NonNullable<typeof preSwapRef.current>): boolean {
      const totalBars = candles.length;
      try {
        const latestIdx = ts.timeToIndex(
          realMsToVirtualSeconds(axis, candles[totalBars - 1].ts_ms) as Time,
          true,
        );
        if (typeof latestIdx !== 'number' || !Number.isFinite(latestIdx)) return false;
        // 앵커가 새 데이터 밖이면 lwc 가 findNearest 로 클램프한다 — 여기서는 그것을
        // 그대로 받는다(가장 가까운 데이터 > 사라진 캔들). 라이브 엣지 분기는 애초에
        // 앵커를 안 쓴다.
        const rawAnchor = ts.timeToIndex(realMsToVirtualSeconds(axis, snap.refMs) as Time, true);
        const initialVisibleBars = initialVisibleMinuteBarsFor(timeframe, venue);
        const target = sourceSwapReseatRange({
          atLiveEdge: snap.atLiveEdge,
          spanBars: snap.toLogical - snap.fromLogical,
          totalBars,
          latestIdx,
          anchorIdx:
            typeof rawAnchor === 'number' && Number.isFinite(rawAnchor) ? rawAnchor : null,
          initialVisibleBars,
          rightOffsetBars: minuteRightOffsetBars(
            Math.min(totalBars, initialVisibleBars),
            ts.width(),
          ),
          savedRightPaddingBars: snap.rightPaddingBars,
        });
        const spBefore = ts.scrollPosition();
        ts.setVisibleLogicalRange(target);
        // **내구화** — range set 만으로는 lwc 내부 scrollPosition(마지막 봉 기준
        // 오른쪽 오프셋)이 갱신되지 않아, 다음 setData 재앵커가 직전 오프셋으로
        // 화면을 되돌린다(2026-08-25 실측: 재착석 223ms 뒤 lwc 가 토글 전 span 을
        // 재적용했고, 그 덮인 화면을 후속 재투영이 고정해 [-2040,1083] 허공으로
        // 갔다. set 직후 scrollPosition() 이 여전히 옛값 3534 였던 오전 실측이
        // 같은 근거다). scrollToPosition 이 그 내부 상태를 바꾸는 유일한 경로다 —
        // 단위는 (오른쪽 끝 논리 인덱스 − 마지막 봉 인덱스).
        ts.scrollToPosition(target.to - latestIdx, false);
        // **관측** — 이 표면은 여섯 번 다시 고쳐졌고(#1576~#1581 · #1583), 매번
        // "발화했는데 되돌려졌나 / 애초에 발화를 안 했나" 를 브라우저에서 가르지
        // 못한 것이 재작업의 원인이었다. `spBefore`→`spAfter` 가 그 둘을 가른다:
        // 값이 안 바뀌었으면 set 이 안 먹은 것이고, 바뀐 뒤 나중에 되돌아왔으면
        // 후속 setData 재앵커다(#1581 의 실패 서명).
        //
        // `anchorOut` 은 **다른 갈래**를 연다 — 스왑 전 위치가 새 소스의 데이터
        // 범위 밖이면(디스크→벤더는 250일 벽이 있어 흔하다) 재착석의 목표 자체가
        // 없고, lwc 가 가장 가까운 봉으로 클램프해 화면이 **크게 점프한다.**
        //
        // ⚠ ** 로는 이 판정을 못 한다** — 그 함수가 이미
        // 클램프된 인덱스를 돌려주므로 결과는 항상 유한하고, 종전 판정
        // ()은 **언제나 false** 였다. 2026-08-26
        // 실측이 그 눈먼 상태를 보여 준다: 팬 위치 −23,880바에서 토글 OFF 하니
        // `target from=0 · total=12757`(벤더 250일치)로 클램프됐는데 그때도
        // `anchorOut=false` 였다. 원본 시각을 **첫 봉과 직접 비교**해야 한다.
        livePerfLog('viewport_reseat', {
          code,
          timeframe,
          kind: 'source_swap',
          d: `from=${Math.round(target.from)} to=${Math.round(target.to)} spB=${Math.round(spBefore)} spA=${Math.round(ts.scrollPosition())} anchorOut=${snap.refMs < candles[0].ts_ms} total=${totalBars} snapFrom=${Math.round(snap.fromLogical)} snapTo=${Math.round(snap.toLogical)} latest=${Math.round(latestIdx)}`,
        });
        return true;
      } catch (e) {
        // 차트가 effect 사이에 사라진 경우. 조용한 no-op 이 "아직 안 고쳐졌다" 로
        // 읽히지 않게 dev 에서 드러낸다(리포지셔너와 같은 규율).
        if (import.meta.env.DEV) console.warn('[live] source-swap reseat threw', e);
        return false;
      }
    }
    // Earliest candle actually drawn — mirror projectCandle's axis.contains
    // filter. Absolute ts_ms is stable under the axis re-base.
    let newEarliest: number | null = null;
    for (const c of bundle.candles) {
      if (!axis.contains(c.ts_ms)) continue;
      if (newEarliest === null || c.ts_ms < newEarliest) newEarliest = c.ts_ms;
    }
    const prevEarliest = prevEarliestTsMsRef.current;
    prevEarliestTsMsRef.current = newEarliest;
    // 캔들 배열의 지문. **마지막 봉을 넣지 않는 것**이 계약이다 — SSE 틱이 그것만
    // 움직이므로, 넣으면 매 틱이 "정체성이 갈렸다" 로 읽혀 재착석이 상시 발화한다.
    const identity = `${bundle.candles.length}|${bundle.candles[0]?.ts_ms ?? ''}`;
    const prevIdentity = prevCandleIdentityRef.current;
    prevCandleIdentityRef.current = identity;
    const isMinute = isMinuteTimeframe(timeframe);
    const snap = preSwapRef.current;

    // 2a. 소스 스왑 재착석. 키가 갈렸고(1b 래치) **캔들도 실제로 갈린** 첫 커밋에서
    // 한 번. 분봉 전용이다 — 캘린더 봉의 재배치는 `LiveChartRoot` 의 초기 뷰 effect 가
    // 소유하므로(캔들 수가 바뀌면 스스로 다시 앉힌다) 여기서 겹치면 둘이 싸운다.
    // `canTriggerBackfill()` 은 "초기 뷰 배치가 끝났는가" 를 나른다(그 콜백의 정의).
    // 배치 전에 앉히면 초기 뷰 effect 와 같은 커밋에서 두 주체가 뷰포트를 다툰다.
    if (
      swapPendingRef.current
      && isMinute
      && prevIdentity !== null
      && identity !== prevIdentity
      && canTriggerBackfill()
    ) {
      swapPendingRef.current = false;
      if (snap && reseatAfterSourceSwap(snap)) return;
      // 스냅샷이 없거나 재착석이 스스로 포기한 경우. 여기까지 왔다는 것은 래치는
      // 옳게 섰는데 **실행이 안 됐다**는 뜻이라, 아래 반려 로그와 사유가 다르다.
      livePerfLog('viewport_reseat_skip', {
        code, timeframe, kind: 'source_swap', reason: snap ? 'reseat_returned_false' : 'no_snapshot',
      });
    } else if (swapPendingRef.current && isMinute) {
      // **반려 사유를 말한다.** 2a 는 게이트 넷을 모두 통과해야 발화하는데, 종전에는
      // 어디서 떨어졌는지 알 길이 없어 "안 고쳐졌다" 와 "발화 조건이 아니었다" 가
      // 구별되지 않았다 — #1597 에서 배운 규율(반려 경로가 로그 이전이면 완전 침묵)을
      // 이 표면에 적용한다. 래치가 선 커밋에서만 찍으므로 상시 소음이 아니다.
      livePerfLog('viewport_reseat_skip', {
        code,
        timeframe,
        kind: 'source_swap',
        reason: prevIdentity === null
          ? 'no_prev_identity'
          : identity === prevIdentity
            ? 'identity_unchanged'
            : 'initial_view_pending',
      });
    }

    if (prevEarliest === null || newEarliest === null) return;

    // 2b. **중간 삽입** — 디스크 구멍을 키움 보충이 메우면 캔들이 배열 *한가운데* 들어온다.
    // 그 지점 오른쪽 인덱스가 삽입 개수만큼 밀리는데, 왼쪽 경계도 마지막 봉도 안 움직여
    // 아래 프리펜드 게이트가 전부 통과시켜 버린다 — 보정 없이 화면만 다른 시점을 가리킨다.
    // 2026-08-24 사용자 보고가 이것이었다(010140 06-15~08-24 구간의 디스크 구멍 16일:
    // 06-15~07-02 연속 13일 + 07-17 + 08-17). 보충일마다 반복되므로 누적된다.
    //
    // 프리펜드 게이트와 **다른 판별식**이 필요하다. 다섯이 개수만 보면 구별되지 않는다:
    //   프리펜드     firstMs 과거로 · lastMs 불변 · count 증가  → 아래 경로가 처리
    //   중간 삽입    firstMs 불변  · lastMs 불변 · count 증가  → 여기
    //   SSE 성장     firstMs 불변  · lastMs 변함 · count 증가  → 손대지 않는다(lwc 가 우측 핀)
    //   좌측 트림    firstMs 미래로 · lastMs 불변 · count 감소  → isLeftTrim(아래)
    //   유니온 재매핑 firstMs·lastMs·count 전부 불변            → isUnionRemap(아래)
    //
    // `historicalFromDate` 게이트를 우회하는 것이 안전한 이유: 중간 삽입은 **좌단을
    // 건드리지 않아** 3b 의 좌측-팬 판정을 새로 만들지 않는다. #1566 에서 겪은 백필
    // 폭주는 프리펜드 보정이 좌단을 다시 최좌단에 붙이면서 생긴 되먹임이었다.
    const shape = {
      count: candles.length,
      firstMs: candles[0].ts_ms,
      lastMs: candles[candles.length - 1].ts_ms,
    };
    const prevShape = prevCandleShapeRef.current;
    prevCandleShapeRef.current = shape;
    const isMidInsert =
      prevShape !== null
      && shape.firstMs === prevShape.firstMs
      && shape.lastMs === prevShape.lastMs
      && shape.count > prevShape.count;

    // 2c. **좌측 트림** — 창 축소(`planViewportContraction` → `historicalRange.contract`
    // → `trimRangeBundleBefore`)는 디스크 모드(hogaplay/우회) 분봉에서 캔들 배열
    // **왼쪽을 실제로 잘라낸다**. 벤더 모드는 캔들이 별도 병합 캐시라 지표만 잘리지만,
    // 디스크 캔들은 range 창에서 직접 오므로(`useLiveBundle` minuteDiskCandles) 커널
    // 게이트의 전제("분봉 캔들은 병합 캐시가 깊이를 보존" — `planViewportContraction`
    // 주석)가 성립하지 않는다. 트림은 `segments[0]` 을 옮겨 축 원점까지 재매핑하는,
    // 프리펜드와 같은 좌표 전면 무효화인데 종전엔 이 변이만 보정자가 없어 lwc 재앵커가
    // 제멋대로 착지했다 — 2026-08-25 실측(010140 1m hogaplay ON): 11-08 팬 중 12-05 로
    // +23거래일 순간이동, 그 상태의 from<0 이벤트가 left_pan 재확장을 태워 방금 버린
    // 구간을 재요청(contract 1초 뒤 extend), contract ↔ extend 진동.
    //
    // 아래 게이트 우회가 안전한 근거(⚠ #1566 되먹임과 다른 이유): 트림은 뷰포트
    // 좌단보다 CONTRACT_RETAIN_STEPS(1스텝) 과거까지 남기므로 화면의 봉이 전부 살아
    // 있고, 같은 봉을 고정하는 재투영은 from≥0 로 끝나 3b 의 좌측-팬 판정을 만들지
    // 않는다. 재-contract 도 없다 — 트림 직후 창-뷰포트 간격이 정확히 RETAIN(1) <
    // TRIGGER(3) 라 `planViewportContraction` 이 null 을 돌려준다.
    //
    // lastMs 불변 조건이 급소다: 좌단·우단이 함께 바뀌는 것은 트림이 아니라 소스
    // 교체(2a 의 소유)이고, 그때 이 경로가 함께 움직이면 두 주체가 뷰포트를 다툰다.
    const isLeftTrim =
      prevShape !== null
      && shape.firstMs > prevShape.firstMs
      && shape.lastMs === prevShape.lastMs
      && shape.count < prevShape.count;

    // 2d. **유니온 재매핑** — 캔들은 그대로인데 공유 timeScale 의 다른 기여자(호가·
    // 사이드카 지표 포인트)가 들어오거나 빠져 **union 인덱스만 통째로 밀리는** 커밋.
    // 소스 토글 직후가 그 진원이다: 웜 병합본이 잠깐 서빙됐다 창 트림으로 되잘리며
    // 지표 포인트 수천 개가 출렁이는데, 캔들 모양(firstMs·lastMs·count)은 불변이라
    // 위 네 행이 모두 눈멀었다 — 2026-08-25 사용자 실측(034020 5m 장중): 창 축소·
    // 스왑 홀드·재착석이 전부 정상 발동하고도 최종 뷰포트가 데이터 밖에 좌초했다.
    //
    // 판별식이 성긴 것("전부 불변")이 안전한 이유는 **재투영이 자기 게이트를 갖기
    // 때문**이다: 아래 경로는 shift = newIdx - refIdx 를 재고 EPSILON 안이면 아무
    // 것도 하지 않는다. 즉 이 행이 여는 것은 "매 캔들-불변 커밋마다 timeToIndex 로
    // 이동량을 재 본다"까지이고, 실제 set 은 유니온이 정말 밀렸을 때만 나간다
    // (SSE 시세 틱은 lastMs 가 움직여 애초에 이 행이 아니고, 지표-불변 ref churn 은
    // shift 0 으로 스킵된다 — 둘 다 테스트가 못박는다).
    //
    // 게이트 우회가 안전한 근거는 중간 삽입(2b)과 같다: 같은 봉을 고정하는 재투영은
    // 좌단을 데이터 최좌단에 다시 붙이는 방향이 아니라 #1566 되먹임을 만들지 않는다.
    const isUnionRemap =
      prevShape !== null
      && shape.firstMs === prevShape.firstMs
      && shape.lastMs === prevShape.lastMs
      && shape.count === prevShape.count;

    // ⚠ **이 게이트를 분봉에서 풀지 말 것 — 2026-08-24 에 풀었다가 되돌렸다.**
    //
    // 동기는 타당했다: `historicalFromDate` 는 "좌측 팬을 한 적이 있다" 는 뜻인데
    // **로드된 데이터 안에서** 뒤로 본 사용자는 그걸 세우지 않으므로, 그 상태의 디스크
    // 청크 워크백 프리펜드가 보정 없이 화면을 민다. 그런데 풀어 보니 **백필이
    // 연쇄했다**(실측: hogaplay 토글 한 번에 84봉 → 1,688봉, 아직도 진행 중).
    //
    // 기전: 리포지셔너의 `setVisibleLogicalRange` 는 lwc 의 논리범위 구독을 깨우고,
    // 그것이 3b 의 좌측-팬 판정을 태운다. 워크백 프리펜드마다 화면이 최좌단에 다시
    // 붙으므로 그 판정이 매번 참이 되고, 디스크 모드엔 250일 벽이 없어 멈출 것이
    // 없다. 즉 "보정" 이 "요청" 을 낳는 되먹임이다 — 프리펜드가 사용자 팬에서 오는
    // 종전 경로에는 이 되먹임이 없다(팬이 이미 그 요청의 원인이므로).
    if (!isMidInsert && !isLeftTrim && !isUnionRemap) {
      if (historicalRange.snapshot().historicalFromDate === null) return;
      if (newEarliest >= prevEarliest) return;
    }
    if (!snap) return;
    try {
      // Reproject the snapshot's right-edge bar through the rebuilt axis. Its
      // union index moved by exactly the number of points inserted ahead of it;
      // translating the snapshot window by that shift pins the user's bars.
      // Round the virtual seconds: UTCTimestamp must be an integer and the
      // toReal→toVirtual round-trip can land a hair off a bar boundary.
      const refVirtual = Math.round(axis.toVirtual(snap.refMs) / 1000);
      const newIdx = ts.timeToIndex(refVirtual as Time, true);
      if (newIdx === null) return;
      const shift = newIdx - snap.refIdx;
      // **축이 안 움직였으면 보정할 것이 없다 — 사용자 입력이 이긴다.**
      //
      // shift 는 "기준 봉의 union 인덱스가 이 커밋에서 얼마나 밀렸나" 다. 0 이면
      // 좌표계가 그대로라는 뜻이고, 그때 스냅샷과 현재 위치의 차이는 **전부 사용자가
      // 만든 것**이다(드래그·휠). 그걸 스냅샷으로 되돌리면 입력을 취소하게 된다.
      //
      // 아래 EPSILON 게이트로는 못 거른다 — 그 비교는 「lwc 가 알아서 제자리를 지켰다」와
      // 「사용자가 그 사이 움직였다」를 **구별하지 못한다**(둘 다 target 과 cur 이 다를
      // 뿐이다). 스냅샷은 레이아웃 단계, 이 effect 는 passive 단계라 그 사이에 프레임이
      // 뜨고, 드래그 중이면 사용자는 이미 움직인 뒤다.
      //
      // 2026-08-25 사용자 보고가 이것이었다: 드래그로 스크롤하면 차트가 좌우로 흔들린다.
      // SSE 틱은 마지막 봉 값만 갱신해 캔들 모양이 불변이라 `isUnionRemap` 행에 걸려
      // 이 경로를 **매 틱** 타는데(그전엔 진짜 프리펜드에서만 탔다), 그때마다 드래그를
      // 스냅샷 위치로 되돌려 진동이 됐다.
      if (shift === 0) return;
      const target = { from: snap.fromLogical + shift, to: snap.toLogical + shift };
      // Live-edge case (①): lwc preserved the view on its own — re-setting the
      // same range would only risk a redundant repaint. Skip within tolerance.
      const cur = ts.getVisibleLogicalRange();
      if (
        cur &&
        Math.abs(cur.from - target.from) < REPOSITION_EPSILON &&
        Math.abs(cur.to - target.to) < REPOSITION_EPSILON
      ) {
        return;
      }
      const spBefore = ts.scrollPosition();
      ts.setVisibleLogicalRange(target);
      // **내구화** — range set 은 lwc 내부 scrollPosition(마지막 봉 기준 오른쪽
      // 오프셋)을 갱신하지 않아, 다음 setData 재앵커가 직전 오프셋으로 화면을
      // 되돌린다(근거·실측은 `reseatAfterSourceSwap` 의 같은 주석). 재투영이 앉힌
      // 자리를 내부 상태에도 새겨 고정이 커밋을 넘어 살아남게 한다.
      const lastIdx = ts.timeToIndex(
        realMsToVirtualSeconds(axis, candles[candles.length - 1].ts_ms) as Time,
        true,
      );
      if (typeof lastIdx === 'number' && Number.isFinite(lastIdx)) {
        ts.scrollToPosition(target.to - lastIdx, false);
      }
      // 어느 행이 이 재투영을 열었는지까지 남긴다 — 판별식 표(2b/2c/2d + 프리펜드)의
      // 어느 줄이 실제로 작동했는지는 지금까지 추측이었고, 그 추측이 이 표면의
      // 재작업을 낳았다. `shift` 가 곧 "축이 얼마나 밀렸나" 이므로 값이 이상하면
      // 그 자체가 진단이다.
      livePerfLog('viewport_reseat', {
        code,
        timeframe,
        kind: isMidInsert ? 'mid_insert' : isLeftTrim ? 'left_trim' : isUnionRemap ? 'union_remap' : 'prepend',
        // ⚠ **한 문자열로 싣는다.** 브라우저 console 이 객체 payload 를 앞쪽 몇 필드에서
        // 잘라 버려(2026-08-26 실측: `from` 다음이 통째로 사라졌다) 정작 진단에 쓰는
        // 값들이 안 보였다. 이 표면의 관측은 "읽히는 형태" 까지가 요구사항이다.
        d: `shift=${Math.round(shift)} from=${Math.round(target.from)} to=${Math.round(target.to)} spB=${Math.round(spBefore)} spA=${Math.round(ts.scrollPosition())}`,
      });
    } catch (e) {
      // Reachable in practice only when the chart tears down between effect
      // runs. Surface in dev so it isn't a silent no-op read as "still broken".
      if (import.meta.env.DEV) console.warn('[live] viewport reposition threw', e);
    }
  }, [chart, bundle, axis, historicalRange, timeframe, venue, canTriggerBackfill]);

  // 3a. 진행 루프(스텝 2..N): 한 스텝이 settle할 때마다 활성 fill의 예산을 소진하며
  // 다음 스텝을 자가 dispatch한다. 뷰포트는 읽지 않는다 — 예산과 목표는 트리거(3b)
  // 순간에 동결됐고, fill은 그만큼 무조건 완주한다. planFillStep이 종료(예산 소진/
  // 클램프/coverage 목표 도달)를 판정.
  //
  // **"스텝이 settle했다"는 신호가 둘인 이유**(#1328): 종전에는 fetch의 하강 엣지
  // (isExtending true→false)만 봤는데, 그 신호는 **fetch가 실제로 일어나야만** 존재한다.
  // 종목을 떠났다 돌아오면 창 런타임이 리셋돼 historicalFromDate=null이고, 그 상태의
  // 첫 스텝 from은 결정적이라(axis 최좌단 base) 직전 방문의 쿼리 키와 정확히 같다 —
  // 즉 **반드시 캐시 히트**다. 캐시 히트는 fetch가 없어 하강 엣지도 없고, 그러면 이
  // 루프가 endFill에 닿지 못해 fillKind가 영구 non-null로 잠긴다. 그 뒤로는 3b 가드가
  // 모든 트리거를 반려하므로 백필이 1청크에서 죽는다(2026-08-15 실측).
  //
  // 그래서 데이터 기준 신호를 함께 본다: "지금 서빙 중인 창의 from == 방금 요청한 from".
  // 두 신호가 같은 스텝에 겹칠 수 있으므로(콜드 스텝의 착지 커밋) lastAdvancedFromRef가
  // 예산 이중 집행을 막는다.
  useEffect(() => {
    const wasExtending = prevExtendingRef.current;
    prevExtendingRef.current = isExtending;
    if (!chart) return;
    if (!canTriggerBackfill()) return;
    if (fillKindRef.current === null) return; // 활성 fill 없음 (예: 초기 로드 settle)
    // 초기 캔들 미로드(빈 차트)면 백필 폭주 금지 — candleCountRef 주석 참조.
    if (candleCountRef.current === 0) return;
    const cur = historicalRange.snapshot().historicalFromDate;
    const settledByFetch = wasExtending && !isExtending;
    // 캐시 settle: fetch 없이 요청 창이 그대로 서빙되고 있다. isExtending 가드는
    // 콜드 스텝 진행 중의 placeholder(이전 창 from)를 배제하는 것과 별개로,
    // "지금 아무 스텝도 날고 있지 않다"를 명시해 하강 엣지 경로와 상호배타로 둔다.
    const settledByCache =
      !isExtending && cur !== null && settledFromDate === cur && lastAdvancedFromRef.current !== cur;
    if (!settledByFetch && !settledByCache) return;
    const endFill = () => {
      fillKindRef.current = null;
      fillBudgetRef.current = 0;
      fillCoverageTargetRef.current = null;
      fillStepCountRef.current = 0;
      lastAdvancedFromRef.current = null;
    };
    if (cur === null || axis.segments.length === 0) {
      endFill();
      return;
    }
    lastAdvancedFromRef.current = cur;
    const plan = planFillStep({
      kind: fillKindRef.current,
      historicalFromDate: cur,
      axisEarliestMs: axis.segments[0].sessionOpenMs,
      earliestAllowedDate: minuteScrollbackFloorDate,
      timeframe,
      stepCount: fillStepCountRef.current,
      budget: fillBudgetRef.current,
      coverageTargetDate: fillCoverageTargetRef.current,
      rangeWindowFromDate: rangeWindowFromRef.current,
    });
    if (plan.action === 'stop') {
      livePerfLog('viewport_backfill_stop', {
        code,
        timeframe,
        kind: fillKindRef.current,
        historicalFromDate: cur,
        stepCount: fillStepCountRef.current,
        budget: fillBudgetRef.current,
      });
      endFill();
      return;
    }
    fillStepCountRef.current += plan.steps;
    livePerfLog('viewport_backfill_extend', {
      code,
      timeframe,
      trigger: 'settle_loop',
      kind: fillKindRef.current,
      from: cur,
      nextFrom: plan.nextFrom,
      steps: plan.steps,
      stepCount: fillStepCountRef.current,
      budget: fillBudgetRef.current,
      candleCount: candleCountRef.current,
    });
    historicalRange.extend(plan.nextFrom);
    // settledFromDate는 원시 문자열이라 deps에 값으로 들어간다 — 주기 refetch는 같은
    // from을 되싣으므로 effect가 재실행되지 않는다(candleCountRef식 ref 미러 불요).
  }, [chart, axis, timeframe, isExtending, canTriggerBackfill, historicalRange, settledFromDate]);

  // 3b. Lazy fetch trigger — extend historicalFromDate when user scrolls past
  // the leftmost loaded candle.
  //
  // Why logical range, not time range: subscribeVisibleTimeRangeChange clamps
  // r.from to the first candle's time (verified by wheel-pan test: from
  // decreases monotonically toward 0 and STOPS there — never negative). So
  // a time-API guard can never detect "user dragged past leftmost".
  // subscribeVisibleLogicalRangeChange emits FRACTIONAL bar indices that
  // freely go negative past the leftmost bar (-50.3 etc.), which is the
  // signal we actually need.
  //
  // Each step is STEP_TRADING_DAYS wide (weekend-skipped): minute = 5 trading
  // days (~1,950 bars at 1m → one backend date-parallel batch, ADR-0105),
  // D/W/M = 50/250/1050 trading days (~50 candles). A minute step is sized to
  // one parallel backend batch, not one bar-count — deep pans commit every 5
  // trading days instead of every single day. A single dispatch may BATCH up to
  // MAX_BATCH_STEPS_PER_DISPATCH steps (ADR-0120) — the settle-loop is serial, so
  // batching halves the round-trips at the same backend cost (그 상한이 왜 2인지는
  // liveDateTime.MAX_BATCH_STEPS_PER_DISPATCH 주석의 3-상수 불변식 참조).
  // The 150ms trailing debounce coalesces rapid wheel / drag events into one
  // fetch; the store's extendHistoricalRange is monotonically decreasing, so
  // repeated negative ranges within one chunk are no-ops.
  useEffect(() => {
    if (!chart) return;
    const ts = chart.timeScale();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const handler = (range: unknown) => {
      // 모든 게이트보다 먼저 — 게이트에 반려되는 이벤트(백프레셔 포함)도 "가장 최근
      // 뷰포트 보고" 로서는 유효하고, 발화 시점 재검증이 그 최신값을 읽는다.
      const reportedFrom = (range as { from?: number | null } | null)?.from;
      if (typeof reportedFrom === 'number') latestLogicalFromRef.current = reportedFrom;
      if (!canTriggerBackfill()) return;
      // Lazy-fetch runs for every LiveTimeframe, including D/W/M. Without
      // this, D/W/M users dragging past the leftmost bar saw nothing happen.
      // 분봉 tf 는 이제 timeframe-DEPENDENT 다 — /past-candles 가 bucket_ms 로
      // 표시 tf 봉을 직접 받으므로(#1008) tf 전환은 쿼리키가 갈려 그 tf 의
      // 워크백이 처음부터 다시 돈다. D/W/M 은 past-daily-candles 경로라 무관.
      if (axis.segments.length === 0) return;
      // 초기 캔들이 아직 0개면 트리거 금지: 빈 차트도 logical.from<0을 보고하지만
      // 그건 "팬"이 아니라 "데이터 미도착"이다. 가드 없으면 historicalFromDate가
      // 250일 클램프까지 폭주해 거대 uncached fetch가 영구 pending → 빈 차트.
      if (candleCountRef.current === 0) return;
      // Backpressure + 예산 보호: 진행 중인 스텝이 있거나 활성 fill이 예산을
      // 소진 중이면 새 트리거를 받지 않는다 — 동결된 예산을 덮어쓰면 "fill 도중
      // 인터랙션이 fill을 연장하지 못한다"는 계약이 깨진다. fill이 끝난 뒤의
      // 다음 뷰포트 이벤트가 남은 빈공간을 새 예산으로 배치 처리한다.
      // Re-checked inside the debounce timer too, since the 150ms wait can
      // straddle a fill start.
      if (isExtendingRef.current || fillKindRef.current !== null) return;
      const r = range as { from?: number | null; to?: number | null } | null;
      if (!r || r.from == null) return;
      // 두 트리거 경로:
      //  1. left_pan(기존): logical.from<0 = 최좌단 캔들보다 왼쪽으로 팬. axis-base로
      //     캔들+지표 동반 확장. 예산 = 트리거 순간의 빈공간 바 수 ÷ 스텝당 봉 수.
      //  2. coverage_gap(A안): logical.from≥0(캔들 안)이지만 viewport 좌단이 range 지표
      //     커버리지보다 과거면, 캔들은 병합 캐시로 복원됐는데 지표만 뒤처진 구간이다.
      //     window-base nextCoverageFrom으로 range 창만 확장(axis-base 금지 — 복원된
      //     캔들로 폭발). 목표 = 트리거 순간의 viewport 좌단 날짜(동결).
      const cur = historicalRange.snapshot().historicalFromDate;
      let trigger: 'left_pan' | 'coverage_gap';
      let nextFrom: string;
      let budget: number;
      let steps = 1;
      let coverageTarget: string | null = null;
      if (r.from < 0) {
        trigger = 'left_pan';
        budget = Math.min(fillBudgetSteps(-r.from, timeframe), MAX_FILL_STEPS);
        // 첫 dispatch도 3a와 같은 배치 폭을 쓴다(ADR-0120) — 여기만 1스텝이면
        // 딥 팬의 첫 왕복이 나머지보다 좁아 계단이 생긴다.
        steps = dispatchStepsFor(timeframe, budget);
        nextFrom = nextHistoricalFrom(axis.segments[0].sessionOpenMs, cur, timeframe, steps);
      } else {
        const covPlan = planCoverageGapFill(
          chart, axis, timeframe, cur, coverageFromRef.current, rangeWindowFromRef.current,
        );
        if (!covPlan) {
          // **확장이 필요 없는 순간이 곧 축소를 볼 자리다.** 여기 도달했다는 것은
          // 뷰포트 좌단이 커버리지 오른쪽이라는 뜻이므로, 창이 과하게 넓으면 앞으로
          // 당긴다(`planViewportContraction` 이 히스테리시스를 쥔다).
          //
          // 확장 판정 **뒤**에 두는 것이 요점이다 — 앞에 두면 같은 이벤트에서 자르고
          // 곧바로 늘리는 왕복이 가능해진다.
          const leftDate = readViewportLeftDate(chart, axis);
          const contractTo = leftDate
            ? planViewportContraction(cur, leftDate, timeframe)
            : null;
          if (contractTo !== null) {
            livePerfLog('viewport_backfill_contract', {
              code, timeframe, from: cur, contractTo, leftDate,
            });
            historicalRange.contract(contractTo);
          }
          return;
        }
        trigger = 'coverage_gap';
        nextFrom = covPlan.nextFrom;
        budget = MAX_FILL_STEPS; // 종료는 날짜 수렴이 담당, 예산은 백스톱
        coverageTarget = covPlan.coverageTarget;
      }
      // SR-3: the holiday-span / monotonic-decrease backfill policy lives in the
      // pure nextHistoricalFrom / nextCoverageFrom kernels (liveDateTime,
      // table-tested). This effect keeps only the imperative shell: trigger gate,
      // debounce, store dispatch.
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        const view = viewGuard();
        if (view.timeframe !== timeframe) return;
        if (view.code && view.code !== code) return;
        // Re-check at fire time: a fill may have started during the debounce
        // window. Skip — its budget owns the pipeline until it completes.
        if (isExtendingRef.current || fillKindRef.current !== null) {
          livePerfLog('viewport_backfill_skip', {
            code,
            timeframe,
            trigger,
            logicalFrom: r.from,
            from: cur,
          });
          return;
        }
        // 발화 시점 뷰포트 재검증(left_pan): 트림/프리펜드 커밋 중 lwc 내부 re-anchor 가
        // 잠깐 from<0 을 보고해 이 디바운스를 무장시킬 수 있다. 2026-08-25 실측(010140
        // 1m hogaplay ON): contract 의 트림 커밋에서 lwc 과도 이벤트(-1180)가 디바운스를
        // 세웠고, 리포지셔너(2c)가 같은 커밋에서 뷰포트를 되돌린 뒤에도 150ms 뒤 타이머가
        // 방금 버린 창을 재확장했다 — contract ↔ extend 진동. from≥0 이벤트는 이 분기에
        // 도달하지 않아 타이머를 걷지 못하므로, 발화 시점에 **가장 최근 이벤트**의 from
        // 으로 빈공간이 실제로 남아 있는지 재확인한다(리포지셔너의 보정 set 도 구독
        // 이벤트를 내므로 ref 가 항상 최신이다). 디바운스 사이에 사용자가 오른쪽으로
        // 되돌아온 경우도 같은 이유로 반려된다 — 채울 빈공간이 없다. coverage_gap 은
        // from≥0 트리거라 이 서명이 성립하지 않아 대상이 아니다.
        if (trigger === 'left_pan') {
          const latest = latestLogicalFromRef.current;
          if (latest === null || latest >= 0) {
            livePerfLog('viewport_backfill_skip', {
              code,
              timeframe,
              trigger,
              logicalFrom: r.from,
              latestLogicalFrom: latest,
              from: cur,
            });
            return;
          }
        }
        // fill 상태는 실제 dispatch 직전에만 동결 — 위의 가드들로 반려된 이벤트가
        // 유령 활성 fill을 남기면(안 그러면) falling edge가 없어 영구 잠금된다.
        fillKindRef.current = trigger;
        fillBudgetRef.current = budget;
        fillCoverageTargetRef.current = coverageTarget;
        fillStepCountRef.current = steps; // 이 dispatch가 소모한 예산 단위
        livePerfLog('viewport_backfill_extend', {
          code,
          timeframe,
          trigger,
          logicalFrom: r.from,
          from: cur,
          nextFrom,
          steps,
          stepCount: fillStepCountRef.current,
          budget,
          candleCount: candleCountRef.current,
        });
        historicalRange.extend(nextFrom);
      }, 150);
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(handler));
    };
  }, [chart, axis, timeframe, canTriggerBackfill, historicalRange, viewGuard]);

  // 3c. 초기 표시 coverage_gap 판정(1회). 3b는 subscribeVisibleLogicalRangeChange
  // 이벤트에만 발화하므로, 저장 뷰포트가 처음부터 지표 커버리지 밖 과거를 보고 있으면
  // 사용자가 팬/줌하기 전까지 지표가 빈 채 방치됐다. PR-1/2가 "받아본 범위"는 복원하니
  // 여기 남는 갭은 캔들 병합 캐시가 지표보다 원래 깊은 경우(주로 타임프레임 전환 —
  // 캔들 merged key는 tf 무관, range identity는 bucketMs 포함이라 tf 전환마다 지표 콜드).
  //
  // 판정 로직·게이트·fill 동결은 3b와 완전 동일(planCoverageGapFill 공유) — 다른 점은
  // 트리거 소스뿐(뷰포트 이벤트 대신 최초 캔들+지표 신호 준비 커밋)이다. 발화하면
  // fillKindRef 를 세워 진행 루프(3a)가 나머지 청크 워크백을 이어받는다.
  //
  // 1회성(initialCoverageCheckedRef): 캔들이 지표 신호보다 먼저 도착하므로, 마킹은
  // coverage 신호가 유효해진(non-null) 첫 커밋에서만 한다 — 캔들만 온 이른 커밋에서
  // 마킹하면 지표 도착 후 재판정을 영영 못 한다. 갭이 없다고 판정돼도 마킹은 유지해
  // 반복 판정을 막고, 이후는 3b의 이벤트 트리거가 담당한다.
  useEffect(() => {
    if (initialCoverageCheckedRef.current) return;
    if (!chart || !bundle || bundle.candles.length === 0) return;
    if (!canTriggerBackfill()) return;
    if (axis.segments.length === 0) return;
    // 지표 신호 미도착이면 판정 보류(미마킹) — 다음 커밋 재시도.
    if (indicatorCoverageFromDate === null || rangeWindowFromDate === null) return;
    if (isExtendingRef.current || fillKindRef.current !== null) return;
    initialCoverageCheckedRef.current = true;
    const cur = historicalRange.snapshot().historicalFromDate;
    const covPlan = planCoverageGapFill(
      chart, axis, timeframe, cur, indicatorCoverageFromDate, rangeWindowFromDate,
    );
    if (!covPlan) return; // 갭 없음 — 마킹된 채 종료(반복 판정 금지)
    fillKindRef.current = 'coverage_gap';
    fillBudgetRef.current = MAX_FILL_STEPS;
    fillCoverageTargetRef.current = covPlan.coverageTarget;
    fillStepCountRef.current = 1;
    livePerfLog('viewport_backfill_extend', {
      code,
      timeframe,
      trigger: 'initial_coverage',
      from: cur,
      nextFrom: covPlan.nextFrom,
      stepCount: fillStepCountRef.current,
      budget: fillBudgetRef.current,
      candleCount: bundle.candles.length,
    });
    historicalRange.extend(covPlan.nextFrom);
  }, [chart, bundle, axis, timeframe, canTriggerBackfill, indicatorCoverageFromDate, rangeWindowFromDate, code, historicalRange]);

  // 3d. **순간 이동** 백필 — 저장뷰 구간 시작 또는 기간 점프 목적지까지 워크백한다.
  //
  // **3c 와 같은 형태이고 트리거 소스만 다르다**: 저쪽은 "지표 커버리지가 화면보다 얕다",
  // 이쪽은 "화면이 팬 없이 과거로 옮겨졌다". 둘 다 뷰포트 이벤트가 없는 상황
  // (3b 가 못 잡는 자리)이고, 둘 다 `fillKind` 를 세워 **진행 루프(3a)에 나머지 청크
  // 워크백을 넘긴다**. `coverage_gap` kind 를 그대로 쓰는 이유는 종료 조건이 정확히
  // 같기 때문이다 — 요청 창이 목표 날짜에 닿으면 `planFillStep` 이 stop 한다.
  //
  // 소스가 둘인 것은 **같은 실패를 공유하기 때문**이다. 저장뷰 적용도 점프도 팬을
  // 만들지 않아 3b 가 침묵하고, 단발 `extend` 로는 한 청크에서 멎는다. 목표는 둘 중
  // **더 과거**다 — 저장뷰를 연 채로 점프하면 두 구간이 모두 필요하고, 목표를 하나만
  // 두면 나머지가 영영 안 채워진다.
  //
  // ⚠ **단발 `extend` 로는 안 된다.** 그건 `historicalFromDate` 를 한 번 세팅할 뿐이라
  // 백엔드가 한 청크만 주고 끝나고, `fillKind` 가 null 이라 3a 가 이어받지 못한다.
  // 저장뷰 적용에는 팬이 없으니 그대로 멎는다(2026-08-21 실측, 3분 20초 무변화).
  //
  // 요청이 바뀌면 다시 판정한다(키가 두 날짜의 쌍) — 1회 마킹인 3c 와 다른 점이고,
  // 다른 저장뷰를 열거나 다른 날로 점프하면 그 구간까지 다시 채워야 하므로 그래야 한다.
  const spotTargetFromDate = [savedRangeFromDate, jumpFromDate]
    .filter((d): d is string => d !== null)
    .reduce<string | null>((acc, d) => (acc === null || d < acc ? d : acc), null);
  const spotTargetKey = `${savedRangeFromDate ?? ''}|${jumpFromDate ?? ''}`;
  useEffect(() => {
    if (spotTargetFromDate === null) {
      targetFilledForRef.current = null;
      return;
    }
    if (targetFilledForRef.current === spotTargetKey) return;
    if (!chart || !bundle || bundle.candles.length === 0) return;
    if (!canTriggerBackfill()) return;
    if (axis.segments.length === 0) return;
    if (isExtendingRef.current) return;
    // 요청 창 신호가 아직 없으면 **판정 보류**(미마킹) — 3c 와 같은 규율이다.
    // 넘겨야 `planFillStep` 의 coverage_gap 분기가 서고, 진행 루프(3a)도 같은 값을
    // 읽으므로 여기서 폴백으로 밀고 나가면 3a 가 첫 settle 에서 stop 해 **한 스텝만
    // 가고 멎는다** — 고치려던 그 증상이 그대로 재발한다.
    if (rangeWindowFromDate === null) return;
    // ⚠ `fillKindRef` 가 활성이어도 **요청이 바뀌었으면 덮어쓴다.** 저장뷰 적용도
    // 점프도 명시적 사용자 액션이라 진행 중이던 팬 백필보다 우선한다. 안 그러면
    // 연달아 눌렀을 때 두 번째가 **영영 안 채워진다**(첫 fill 이 끝날 때까지 막힌다).
    const cur = historicalRange.snapshot().historicalFromDate;
    // 하한은 **호출부가 정한다**(모드에 따라 갈리는 값이라) — prop 도크스트링 참조.
    // 벤더 모드면 250일 벽, 디스크 모드면 없음(null). 종전엔 이 자리에서
    // `earliestAllowedMinuteDate` 를 직접 불렀다.
    const earliestAllowedDate = minuteScrollbackFloorDate;
    const target = earliestAllowedDate !== null && spotTargetFromDate < earliestAllowedDate
      ? earliestAllowedDate
      : spotTargetFromDate;
    const plan = planFillStep({
      kind: 'coverage_gap',
      historicalFromDate: cur,
      axisEarliestMs: axis.segments[0].sessionOpenMs,
      earliestAllowedDate,
      timeframe,
      stepCount: 0,
      budget: MAX_FILL_STEPS,
      coverageTargetDate: target,
      rangeWindowFromDate,
    });
    // 이미 목표까지 와 있으면 stop 이다 — 그때도 마킹해 반복 판정을 막는다.
    targetFilledForRef.current = spotTargetKey;
    if (plan.action === 'stop') return;
    fillKindRef.current = 'coverage_gap';
    fillBudgetRef.current = MAX_FILL_STEPS;
    fillCoverageTargetRef.current = target;
    fillStepCountRef.current = 1;
    livePerfLog('viewport_backfill_extend', {
      code,
      timeframe,
      // 어느 순간 이동이 이 fill 을 세웠는가 — 둘이 겹치면 목표가 더 과거인 쪽이다.
      trigger: spotTargetFromDate === jumpFromDate ? 'timeframe_jump' : 'saved_range',
      from: cur,
      nextFrom: plan.nextFrom,
      coverageTarget: target,
      stepCount: fillStepCountRef.current,
      budget: fillBudgetRef.current,
      candleCount: bundle.candles.length,
    });
    historicalRange.extend(plan.nextFrom);
  }, [chart, bundle, axis, timeframe, canTriggerBackfill, spotTargetFromDate, spotTargetKey, jumpFromDate, rangeWindowFromDate, code, historicalRange]);

  // 3e 의 래치는 **(code, timeframe) 스코프**다. 종목이나 봉이 갈리면 다른 축의
  // 날짜가 우연히 같아 "이미 밀었다" 로 오인될 수 있어, 경계에서 명시적으로 지운다.
  useEffect(() => {
    clampRecoveryStepsRef.current = 0;
    clampLastFromRef.current = null;
  }, [code, timeframe]);

  // 3e. **빈 화면 클램프 탈출구** — 뷰포트 이벤트가 고갈된 자리를 커밋으로 메운다.
  //
  // 3b 의 유일한 입력은 `subscribeVisibleLogicalRangeChange` 다. 그런데 데이터 좌단까지
  // 팬하면 lwc 는 화면 폭만큼의 whitespace 만 허용하고 **클램프**한다 — 논리 범위가 더
  // 변하지 않으니 이벤트가 끊기고, 그 하나에 매달린 3b 도 함께 죽는다. 화면은
  // whitespace 100% 로 멈춘 채 남는다. 2026-08-25 실측(010140 5m hogaplay ON, 백엔드
  // 지연 4.5s): 드래그 7회 + 60초 대기에 `viewport_backfill_*` 로그 **0줄**, 우측으로
  // 한 화면 되돌렸다 오면 즉시 부활 — **잠김이 아니라 이벤트 고갈**이다(잠김이라면
  // 왕복해도 안 살아난다. 그 서명은 `project-minute-backfill-warm-cache-lock`).
  //
  // 3c·3d 와 같은 계열이고 트리거 소스만 다르다: 저쪽은 "저장 뷰포트가 지표 커버리지
  // 밖", "화면이 팬 없이 옮겨졌다", 이쪽은 "이벤트가 끊긴 채 화면이 비었다".
  //
  // **왜 그 상태가 생기나**: `planFillStep` 의 실질 종료 조건은 `stepCount >= budget`
  // 이고, 그 예산은 트리거 순간의 whitespace 로 **추정**한다(`fillBudgetSteps`).
  // 확장한 구간이 캡처 구멍이면 캔들이 안 늘어 추정이 빗나가고, whitespace 가 남은 채
  // fill 이 끝난다. 원래는 다음 뷰포트 이벤트가 새 예산을 발급하는데 클램프면 그
  // 이벤트가 영영 안 온다 — 그 발급을 여기서 대신한다.
  //
  // ⚠ 이것은 **탈출구지 속도 개선이 아니다.** 워크백 자체가 느려서 생기는 동결
  // (타일당 수 초 × 스텝당 10타일)은 이 효과와 무관한 별건이다.
  useEffect(() => {
    if (!chart || !bundle || bundle.candles.length === 0) return;
    const lr = chart.timeScale().getVisibleLogicalRange();
    if (!lr) return;
    const span = lr.to - lr.from;
    if (span <= 0) return;
    // 화면이 다시 채워졌으면 이 클램프 구간은 끝났다 — 래치를 되돌린다. 이 복귀가
    // 곧 성공 신호라, 다음 구간은 온전한 상한을 새로 받는다.
    if (lr.to - Math.max(lr.from, 0) > span * EMPTY_VIEWPORT_DATA_RATIO) {
      clampRecoveryStepsRef.current = 0;
      clampLastFromRef.current = null;
      return;
    }
    // 좌측 클램프만 다룬다. `from >= 0` 인데 데이터가 비는 것은 우측 whitespace 쪽
    // 이야기라 확장으로 풀 문제가 아니다.
    if (lr.from >= 0) return;
    if (!canTriggerBackfill()) return;
    if (axis.segments.length === 0) return;
    // 3b 와 같은 백프레셔 — 진행 중인 fill 의 동결된 예산을 덮어쓰지 않는다.
    if (isExtendingRef.current || fillKindRef.current !== null) return;
    if (clampRecoveryStepsRef.current >= MAX_CLAMP_RECOVERY_STEPS) return;
    const cur = historicalRange.snapshot().historicalFromDate;
    // 창이 그대로면 직전 확장이 아무 데도 못 갔다는 뜻이다(단조 감소 가드 또는 바닥).
    // 같은 자리에서 커밋마다 다시 미는 것을 여기서 끊는다.
    if (clampLastFromRef.current === cur) return;
    const budget = Math.min(fillBudgetSteps(-lr.from, timeframe), MAX_FILL_STEPS);
    const steps = dispatchStepsFor(timeframe, budget);
    const nextFrom = nextHistoricalFrom(axis.segments[0].sessionOpenMs, cur, timeframe, steps);
    clampRecoveryStepsRef.current += 1;
    clampLastFromRef.current = cur;
    // 나머지 워크백은 3a 가 이어받는다 — kind 가 `left_pan` 이어야 종료 조건도 같다.
    fillKindRef.current = 'left_pan';
    fillBudgetRef.current = budget;
    fillCoverageTargetRef.current = null;
    fillStepCountRef.current = steps;
    livePerfLog('viewport_backfill_extend', {
      code,
      timeframe,
      trigger: 'clamp_recovery',
      logicalFrom: lr.from,
      from: cur,
      nextFrom,
      steps,
      stepCount: fillStepCountRef.current,
      budget,
      clampStep: clampRecoveryStepsRef.current,
      candleCount: bundle.candles.length,
    });
    historicalRange.extend(nextFrom);
  }, [chart, bundle, axis, timeframe, canTriggerBackfill, code, historicalRange]);
}
