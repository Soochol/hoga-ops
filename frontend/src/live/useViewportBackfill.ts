import { useEffect, useLayoutEffect, useRef } from 'react';
import type { IChartApi, Time } from 'lightweight-charts';
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
}: ViewportBackfillArgs): void {
  // Pre-swap snapshot: the view as of the CURRENT commit's layout phase, with
  // the right edge resolved to real ms through the axis the chart was actually
  // drawn with (prevAxisRef). prevEarliestTsMsRef detects a genuine prepend.
  const preSwapRef = useRef<
    { fromLogical: number; toLogical: number; refMs: number; refIdx: number } | null
  >(null);
  const prevAxisRef = useRef<VirtualAxis | null>(null);
  const prevEarliestTsMsRef = useRef<number | null>(null);
  // 진행 루프: 현재 fill에서 dispatch한 스텝 수(백스톱용) + isExtending 직전값(falling edge 검출).
  const fillStepCountRef = useRef(0);
  const prevExtendingRef = useRef(false);
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

  useEffect(() => {
    preSwapRef.current = null;
    prevAxisRef.current = null;
    prevEarliestTsMsRef.current = null;
    fillStepCountRef.current = 0;
    prevExtendingRef.current = false;
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
    if (useLivePageStore.getState().historicalFromDate === null) return;
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
  }, [chart, bundle, axis]);

  // 3a. 진행 루프(스텝 2..N): 한 스텝 settle(isExtending true→false) 직후 viewport가
  // 아직 빈영역이면 다음 스텝을 자가 dispatch한다. Applies to minute and
  // calendar frames alike; D/W/M users can keep moving left without a manual
  // "one chunk at a time" rhythm.
  // planFillStep이 종료(꽉 참/클램프/백스톱)를 판정. 재배치 effect 뒤에 선언해
  // getVisibleLogicalRange가 재배치 적용 후 위치를 읽도록 한다.
  useEffect(() => {
    const wasExtending = prevExtendingRef.current;
    prevExtendingRef.current = isExtending;
    if (!chart) return;
    if (!canTriggerBackfill()) return;
    if (!(wasExtending && !isExtending)) return; // falling edge만
    // 초기 캔들 미로드(빈 차트)면 백필 폭주 금지 — candleCountRef 주석 참조.
    if (candleCountRef.current === 0) return;
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
      earliestAllowedDate: isMinuteTimeframe(timeframe) ? earliestAllowedMinuteDate(todayKstYyyymmdd()) : null,
      stepCalendarDays: stepChunkDays(timeframe),
      stepCount: fillStepCountRef.current,
      maxSteps: MAX_FILL_STEPS,
    });
    if (plan.action === 'stop') {
      fillStepCountRef.current = 0;
      return;
    }
    fillStepCountRef.current += 1;
    useLivePageStore.getState().extendHistoricalRange(plan.nextFrom);
  }, [chart, axis, timeframe, isExtending, canTriggerBackfill]);

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
      const r = range as { from?: number | null; to?: number | null } | null;
      if (!r || r.from == null) return;
      // logical.from is a fractional bar index; negative = past the leftmost
      // loaded bar, which is exactly the lazy-fetch trigger condition. NOTE:
      // nothing is captured here — the v3 snapshot happens at the prepend
      // commit itself, so user movement after this trigger cannot go stale.
      if (r.from >= 0) return;
      fillStepCountRef.current = 1; // 이 dispatch가 스텝 1
      // SR-3: the holiday-span / monotonic-decrease backfill policy lives in
      // the pure nextHistoricalFrom kernel (liveDateTime, table-tested). This
      // effect keeps only the imperative shell: trigger gate, debounce, store
      // dispatch.
      const cur = useLivePageStore.getState().historicalFromDate;
      const nextFrom = nextHistoricalFrom(axis.segments[0].sessionOpenMs, cur, stepChunkDays(timeframe));
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        const state = useLivePageStore.getState();
        if (state.candleTimeframe !== timeframe) return;
        if (state.activeCode && state.activeCode !== code) return;
        useLivePageStore.getState().extendHistoricalRange(nextFrom);
      }, 150);
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      ts.unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [chart, axis, timeframe, canTriggerBackfill]);
}
