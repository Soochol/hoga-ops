import { useEffect, useRef } from 'react';
import type { IChartApi, ITimeScaleApi, Time } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import type { RangeBundle } from '../api/types';
import { useLivePageStore, type LiveTimeframe, isMinuteTimeframe } from '../state/livePage';
import {
  nextHistoricalFrom,
  stepChunkDays,
  planFillStep,
  earliestAllowedMinuteDate,
  todayKstYyyymmdd,
} from './liveDateTime';

/** 진행 루프 무한 방지 백스톱. 250일 클램프(≈50스텝 @ 5캘린더일)가 먼저 멈추므로
 * 이건 백스톱-of-백스톱(60×5=300일 > 250일). */
const MAX_FILL_STEPS = 60;

/** 좌측 팬 prepend 직전의 STABLE 기준 봉을 캡처한다(real ms + 현재 union logical
 * 인덱스 + 캡처 시점 logical range). 복원 effect가 이 ref로 viewport 위치를
 * 동기 shift해 사용자가 보던 봉을 같은 위치에 고정한다. 스텝 1(드래그 핸들러)과
 * 스텝 2..N(settle-effect)이 공유한다. 캡처 불가(vr/lr/refIdx 누락)면 null. */
function captureViewportShift(
  ts: ITimeScaleApi<Time>,
  axis: VirtualAxis,
): { refMs: number; refIdx: number; fromLogical: number; toLogical: number } | null {
  const vr = ts.getVisibleRange();
  const lr = vr ? ts.getVisibleLogicalRange() : null;
  const refIdx = vr ? ts.timeToIndex(vr.to as Time, true) : null;
  if (!vr || !lr || refIdx === null) return null;
  return {
    refMs: axis.toReal((vr.to as number) * 1000),
    refIdx,
    fromLogical: lr.from,
    toLogical: lr.to,
  };
}

export interface ViewportBackfillArgs {
  chart: IChartApi | null;
  axis: VirtualAxis;
  bundle: RangeBundle | null;
  timeframe: LiveTimeframe;
  /** useLiveBundle.isExtending. false-edge = 한 스텝 settle. */
  isExtending: boolean;
  /** Reset key — backfill anchors clear when the viewed Code changes. */
  code: string;
}

/** Headless controller for /live's leftward-pan historical backfill + viewport
 * preservation. Owns the four backfill anchor refs and the three effects that
 * were previously inline in `LiveChartRoot`:
 *   1. prepend-restore — shifts the visible logical range by the inserted-index
 *      count so the user's bars stay put across a prepend.
 *   2. progressive settle-loop — on each `isExtending` falling edge, fills the
 *      next 3-trading-day step until the viewport is full (minute-only).
 *   3. lazy-fetch trigger — captures the shift anchor + debounced dispatch when
 *      the user pans past the leftmost loaded bar.
 *
 * Effect *declaration order* is load-bearing and preserved here: the restore
 * effect must precede the settle-loop (settle reads `getVisibleLogicalRange`
 * AFTER restore's shift lands), and both are parent effects (they run after
 * `RangeSeriesPane`'s child `setData`). This hook is called from `LiveChartRoot`
 * (the parent), so that parent-after-child ordering still holds.
 *
 * Test surface: today these effects are exercised through `LiveChartRoot`'s
 * lightweight-charts mock. A future deepening can drive the controller through
 * a `TimeScale` port (no real chart) — the refs + effect bodies are already
 * isolated here for that. */
export function useViewportBackfill({
  chart,
  axis,
  bundle,
  timeframe,
  isExtending,
  code,
}: ViewportBackfillArgs): void {
  // viewportShiftRef pins a STABLE reference bar captured the instant a leftward
  // pan triggers a historical fetch: its real ms (survives the axis re-base) plus
  // its logical index at capture time. prevEarliestTsMsRef holds the earliest
  // drawn candle of the last applied bundle so the restore effect can detect a
  // genuine prepend.
  const viewportShiftRef = useRef<
    { refMs: number; refIdx: number; fromLogical: number; toLogical: number } | null
  >(null);
  const prevEarliestTsMsRef = useRef<number | null>(null);
  // 진행 루프: 현재 fill에서 dispatch한 스텝 수(백스톱용) + isExtending 직전값(falling edge 검출).
  const fillStepCountRef = useRef(0);
  const prevExtendingRef = useRef(false);

  useEffect(() => {
    prevEarliestTsMsRef.current = null;
    viewportShiftRef.current = null;
    fillStepCountRef.current = 0;
    prevExtendingRef.current = false;
  }, [code, timeframe]);

  // Historical-prepend viewport preservation. When the user pans left past the
  // leftmost bar, extendHistoricalRange refetches with an earlier `from`, the
  // bundle is rebuilt with older candles PREPENDED, and RangeSeriesPane calls
  // series.setData(fullArray). lightweight-charts keeps the visible LOGICAL
  // range numerically fixed across setData, so inserting N union points at the
  // front slides the previously-viewed bars right by N — the viewport "jumps".
  // We undo that by SHIFTING the visible logical range by exactly N.
  //
  // Why a logical shift, not setVisibleRange(real time): setVisibleRange refits
  // a TIME span into the viewport and the captured span is whitespace-clamped
  // (getVisibleRange pins its left edge to bar 0 while the user is panned into
  // the pre-data whitespace), so it zooms in on EVERY prepend (measured
  // barSpacing 1.6→2.2 over 3 prepends). A logical shift preserves the logical
  // width exactly → barSpacing, and thus the candle scale, is invariant.
  //
  // Why N is read from the chart, not computed as candle count: the shared
  // timeScale's logical index is the UNION across all series, and hoga panes
  // (quote_ratio / fill_strength) sample at a different cadence than candles, so
  // the inserted-index count != candle count. timeToIndex returns the bar's TRUE
  // union index off the rebuilt scale (data-, not pixel-based, so it works even
  // when the reference bar is off-screen), giving the exact shift.
  //
  // Ordering: this parent effect runs AFTER RangeSeriesPane's child setData
  // effect (child effects fire before parent effects within the same bundle
  // commit). useLiveBundle's extension gate makes the prepend land in ONE commit
  // (candles+hoga together) so the shift sees the full union and is computed once
  // — but a brief (~1-2 frame) position flash can still remain on a heavy
  // prepend: a large multi-pane setData flush is internally split across lwc's
  // own rAF render cycles, so the chart can paint the un-shifted frame before
  // this shift lands. It is purely positional (the scale never changes) and not
  // controllable from the React effect phase (verified: layout effects don't
  // close it). Complementary to LiveChartRoot's initial-view effect via
  // historicalFromDate (null → that effect owns the viewport; non-null → this
  // one), so the two never fight over the same render.
  useEffect(() => {
    if (!chart || !bundle || bundle.candles.length === 0) return;
    // [TEMP-DIAG-VIEWPORT] dev-only kill switch for the differential repro.
    if (import.meta.env.DEV && (window as unknown as { __noRestore?: boolean }).__noRestore) return;
    const ts = chart.timeScale();
    // Earliest candle actually drawn — mirror projectCandle's axis.contains
    // filter. The absolute ts_ms is stable under the axis re-base, unlike the
    // virtual time or the logical index.
    let newEarliest: number | null = null;
    for (const c of bundle.candles) {
      if (!axis.contains(c.ts_ms)) continue;
      if (newEarliest === null || c.ts_ms < newEarliest) newEarliest = c.ts_ms;
    }
    const prevEarliest = prevEarliestTsMsRef.current;
    prevEarliestTsMsRef.current = newEarliest;
    // Initial paint and SSE growth are owned by LiveChartRoot's initial-view
    // effect; only the user-driven extension path corrects the viewport here.
    if (useLivePageStore.getState().historicalFromDate === null) return;
    if (prevEarliest === null || newEarliest === null) return;
    // Only a genuine LEFTWARD extension (an older bar appeared) jumps the view.
    // SSE ticks (right edge) and holiday-only chunks (no new trading day) leave
    // the earliest bar unchanged → nothing to correct.
    if (newEarliest >= prevEarliest) return;
    const shiftRef = viewportShiftRef.current;
    if (!shiftRef) return;
    try {
      // The reference bar (real ms, stable under the re-base) now sits at a
      // higher union logical index because older points were inserted ahead of
      // it. shift = newIdx - refIdx = exactly how many union points were
      // inserted. Round the virtual seconds: UTCTimestamp must be an integer and
      // the toReal→toVirtual round-trip can land a hair off a bar boundary.
      const refVirtual = Math.round(axis.toVirtual(shiftRef.refMs) / 1000);
      const newIdx = ts.timeToIndex(refVirtual as Time, true);
      if (newIdx === null) return;
      const shift = newIdx - shiftRef.refIdx;
      if (shift === 0) return;
      // Apply the shift to the CAPTURED pre-prepend logical range, NOT the
      // current one: lightweight-charts' setData does NOT leave the logical range
      // numerically fixed across a prepend (it partially re-anchors it), so
      // reading it back here would compound the chart's own move with ours and
      // double-shift. The captured [from,to] + the inserted-point count is the
      // absolute target that pins the previously-viewed bars at the same scale,
      // overriding whatever setData did.
      ts.setVisibleLogicalRange({
        from: shiftRef.fromLogical + shift,
        to: shiftRef.toLogical + shift,
      });
    } catch (e) {
      // Reachable in practice only when the chart tears down between effect runs
      // (the axis math is total and timeToIndex is guarded above). Surface an
      // unexpected lwc-internal throw in dev so it isn't a silent no-op the user
      // reads as "the jump just wasn't fixed".
      if (import.meta.env.DEV) console.warn('[live] viewport restore shift threw', e);
    }
  }, [chart, bundle, axis]);

  // 진행 루프(스텝 2..N): 한 스텝 settle(isExtending true→false) 직후 viewport가
  // 아직 빈영역이면 다음 스텝을 자가 dispatch한다. minute-only(D/W/M은 one-shot).
  // planFillStep이 종료(꽉 참/클램프/백스톱)를 판정. 복원 effect 뒤에 선언해
  // getVisibleLogicalRange가 shift 적용 후 위치를 읽도록 한다.
  useEffect(() => {
    const wasExtending = prevExtendingRef.current;
    prevExtendingRef.current = isExtending;
    if (!chart) return;
    if (!isMinuteTimeframe(timeframe)) return;
    if (!(wasExtending && !isExtending)) return; // falling edge만
    const cur = useLivePageStore.getState().historicalFromDate;
    if (cur === null) return;
    if (axis.segments.length === 0) return;
    const ts = chart.timeScale();
    let visibleFrom: number | null = null;
    try {
      visibleFrom = ts.getVisibleLogicalRange()?.from ?? null;
    } catch {
      visibleFrom = null;
    }
    const plan = planFillStep({
      visibleFrom,
      historicalFromDate: cur,
      axisEarliestMs: axis.segments[0].sessionOpenMs,
      earliestAllowedDate: earliestAllowedMinuteDate(todayKstYyyymmdd()),
      stepCalendarDays: stepChunkDays(timeframe),
      stepCount: fillStepCountRef.current,
      maxSteps: MAX_FILL_STEPS,
    });
    if (plan.action === 'stop') {
      fillStepCountRef.current = 0;
      return;
    }
    viewportShiftRef.current = captureViewportShift(ts, axis);
    fillStepCountRef.current += 1;
    useLivePageStore.getState().extendHistoricalRange(plan.nextFrom);
  }, [chart, axis, timeframe, isExtending]);

  // Lazy fetch trigger — extend historicalFromDate when user scrolls past
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
  // Each trigger prepends one chunk sized by stepChunkDays(timeframe) — minute
  // = 5 calendar days (3-trading-day step), D = 350, W/M = 840/3720.
  // The 150ms trailing debounce coalesces rapid wheel / drag events into one
  // fetch; the store's extendHistoricalRange is monotonically decreasing, so
  // repeated negative ranges within one chunk are no-ops.
  useEffect(() => {
    if (!chart) return;
    const ts = chart.timeScale();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const handler = (range: unknown) => {
      // Lazy-fetch runs for every LiveTimeframe, including D/W/M. The
      // candle backfill (/api/live/past-candles) is timeframe-independent
      // — useLiveBundle re-aggregates the same 1m bars into D/W/M on the
      // client. Without this, D/W/M users dragging past the leftmost bar
      // saw nothing happen.
      if (axis.segments.length === 0) return;
      const r = range as { from?: number | null; to?: number | null } | null;
      if (!r || r.from == null) return;
      // logical.from is a fractional bar index; negative = past the leftmost
      // loaded bar, which is exactly the lazy-fetch trigger condition.
      if (r.from >= 0) return;
      // Capture a STABLE reference bar before triggering the prepend: its real
      // ms (survives the segments re-base from 0 on every rebuild) and its
      // current union logical index (timeToIndex). The restore effect reprojects
      // the real ms through the rebuilt axis, reads the bar's NEW index, and
      // shifts the visible logical range by the difference so the bars the user
      // is looking at stay put at the same scale. Use the RIGHT edge (vr.to):
      // panned into the left whitespace it is a real, on-data bar (getVisibleRange
      // clamps only the left edge to bar 0). Capture is synchronous here (not in
      // the 150ms debounce) so `axis`/`ts` are the pre-prepend generation the
      // user is looking at — the effect re-subscribes on [chart, axis, timeframe],
      // so this closure is always current.
      // Always overwrite (capture OR clear): a failed capture must not leave a
      // PREVIOUS pan's anchors live for the next prepend's restore.
      viewportShiftRef.current = captureViewportShift(ts, axis);
      fillStepCountRef.current = 1; // 이 dispatch가 스텝 1
      // SR-3: the holiday-span / monotonic-decrease backfill policy lives in
      // the pure nextHistoricalFrom kernel (liveDateTime, table-tested). This
      // effect keeps only the imperative shell: trigger gate, anchor capture,
      // debounce, store dispatch.
      const cur = useLivePageStore.getState().historicalFromDate;
      const nextFrom = nextHistoricalFrom(axis.segments[0].sessionOpenMs, cur, stepChunkDays(timeframe));
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        useLivePageStore.getState().extendHistoricalRange(nextFrom);
      }, 150);
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      ts.unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [chart, axis, timeframe]);
}
