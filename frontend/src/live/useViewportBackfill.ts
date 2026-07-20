import { useEffect, useLayoutEffect, useRef } from 'react';
import type { IChartApi, Time } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import type { RangeBundle } from '../api/types';
import { type LiveTimeframe, isMinuteTimeframe } from '../state/livePage';
import { useHistoricalRangeActions, useWindowViewGuard } from './workspace/windowView';
import {
  nextHistoricalFrom,
  nextCoverageFrom,
  planFillStep,
  fillBudgetSteps,
  dispatchStepsFor,
  earliestAllowedMinuteDate,
  todayKstYyyymmdd,
  realMsToYyyymmdd,
} from './liveDateTime';
import { livePerfLog } from '../util/perfDebug';

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
  /** useLiveBundle.isExtending. false-edge = 한 스텝 settle. */
  isExtending: boolean;
  /** Reset key — per-code state (snapshot, fill-step counter) clears on switch. */
  code: string;
  /** Backfill must not race the initial live-edge viewport placement. */
  canTriggerBackfill?: () => boolean;
  /** Coverage-gap 백필(A안): 활성 range 지표(hoga/sidecar)가 도달한 가장 최근 from_date.
   * 캔들이 병합 캐시로 더 과거까지 복원돼도 지표가 이 날짜까지만 있으면, viewport 좌단이
   * 이보다 과거일 때 whitespace 없이도 range 창을 확장한다. 분봉 외/미로드면 null → 비활성. */
  indicatorCoverageFromDate?: string | null;
  /** 지금 range가 요청 중인 창의 from — nextCoverageFrom base의 null-fallback. */
  rangeWindowFromDate?: string | null;
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
  isExtending,
  code,
  canTriggerBackfill = () => true,
  indicatorCoverageFromDate = null,
  rangeWindowFromDate = null,
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
    { fromLogical: number; toLogical: number; refMs: number; refIdx: number } | null
  >(null);
  const prevAxisRef = useRef<VirtualAxis | null>(null);
  const prevEarliestTsMsRef = useRef<number | null>(null);
  // 진행 루프: 현재 fill에서 dispatch한 스텝 수 + isExtending 직전값(falling edge 검출).
  const fillStepCountRef = useRef(0);
  const prevExtendingRef = useRef(false);
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
    fillStepCountRef.current = 0;
    prevExtendingRef.current = false;
    fillKindRef.current = null;
    fillBudgetRef.current = 0;
    fillCoverageTargetRef.current = null;
    initialCoverageCheckedRef.current = false;
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
    try {
      const lr = ts.getVisibleLogicalRange();
      const vr = ts.getVisibleRange();
      const refIdx = vr ? ts.timeToIndex(vr.to as Time, true) : null;
      preSwapRef.current =
        lr && vr && refIdx !== null && prevAxis && prevAxis.segments.length > 0
          ? {
              fromLogical: lr.from,
              toLogical: lr.to,
              refMs: prevAxis.toReal((vr.to as number) * 1000),
              refIdx,
            }
          : null;
    } catch {
      preSwapRef.current = null;
    }
    prevAxisRef.current = axis;
  }, [chart, bundle, axis]);

  // 2. Repositioner. Runs after the child setData in the same commit. Only a
  // genuine LEFTWARD extension repositions — initial paint and SSE growth are
  // owned by LiveChartRoot's initial-view effect (mutually exclusive via
  // historicalFromDate), and holiday-only chunks change nothing on screen.
  useEffect(() => {
    if (!chart || !bundle || bundle.candles.length === 0) return;
    const ts = chart.timeScale();
    // Earliest candle actually drawn — mirror projectCandle's axis.contains
    // filter. Absolute ts_ms is stable under the axis re-base.
    let newEarliest: number | null = null;
    for (const c of bundle.candles) {
      if (!axis.contains(c.ts_ms)) continue;
      if (newEarliest === null || c.ts_ms < newEarliest) newEarliest = c.ts_ms;
    }
    const prevEarliest = prevEarliestTsMsRef.current;
    prevEarliestTsMsRef.current = newEarliest;
    if (historicalRange.snapshot().historicalFromDate === null) return;
    if (prevEarliest === null || newEarliest === null) return;
    if (newEarliest >= prevEarliest) return;
    const snap = preSwapRef.current;
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
      ts.setVisibleLogicalRange(target);
    } catch (e) {
      // Reachable in practice only when the chart tears down between effect
      // runs. Surface in dev so it isn't a silent no-op read as "still broken".
      if (import.meta.env.DEV) console.warn('[live] viewport reposition threw', e);
    }
  }, [chart, bundle, axis, historicalRange]);

  // 3a. 진행 루프(스텝 2..N): 한 스텝 settle(isExtending true→false)마다 활성
  // fill의 예산을 소진하며 다음 스텝을 자가 dispatch한다. 뷰포트는 읽지 않는다
  // — 예산과 목표는 트리거(3b) 순간에 동결됐고, fill은 그만큼 무조건 완주한다.
  // planFillStep이 종료(예산 소진/클램프/coverage 목표 도달)를 판정.
  useEffect(() => {
    const wasExtending = prevExtendingRef.current;
    prevExtendingRef.current = isExtending;
    if (!chart) return;
    if (!canTriggerBackfill()) return;
    if (!(wasExtending && !isExtending)) return; // falling edge만
    if (fillKindRef.current === null) return; // 활성 fill 없음 (예: 초기 로드 settle)
    const endFill = () => {
      fillKindRef.current = null;
      fillBudgetRef.current = 0;
      fillCoverageTargetRef.current = null;
      fillStepCountRef.current = 0;
    };
    // 초기 캔들 미로드(빈 차트)면 백필 폭주 금지 — candleCountRef 주석 참조.
    if (candleCountRef.current === 0) return;
    const cur = historicalRange.snapshot().historicalFromDate;
    if (cur === null || axis.segments.length === 0) {
      endFill();
      return;
    }
    const plan = planFillStep({
      kind: fillKindRef.current,
      historicalFromDate: cur,
      axisEarliestMs: axis.segments[0].sessionOpenMs,
      earliestAllowedDate: isMinuteTimeframe(timeframe) ? earliestAllowedMinuteDate(todayKstYyyymmdd()) : null,
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
  }, [chart, axis, timeframe, isExtending, canTriggerBackfill, historicalRange]);

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
      if (!canTriggerBackfill()) return;
      // Lazy-fetch runs for every LiveTimeframe, including D/W/M. The
      // candle backfill (/api/live/past-candles) is timeframe-independent
      // — useLiveBundle re-aggregates the same 1m bars into D/W/M on the
      // client. Without this, D/W/M users dragging past the leftmost bar
      // saw nothing happen.
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
        if (!covPlan) return;
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
      ts.unsubscribeVisibleLogicalRangeChange(handler);
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
}
