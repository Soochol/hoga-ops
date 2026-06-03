import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  createChartEx,
  TickMarkType,
  type IChartApi,
  type ITimeScaleApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { createKstHorzScaleBehavior } from '../util/kstHorzScaleBehavior';
import { resolveTokens } from '../util/tokens';
import {
  CHART_CROSSHAIR_OPTIONS,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';
import { createVirtualAxis, type VirtualAxis } from '../util/virtualAxis';
import RangeSeriesPane from '../chart/RangeSeriesPane';
import { paneSpecsForTimeframe } from './paneSpecsForTimeframe';
import DayBoundaryOverlay from '../chart/DayBoundaryOverlay';
import {
  useLivePageStore,
  type LiveTimeframe,
  isMinuteTimeframe,
  isCalendarTimeframe,
} from '../state/livePage';
import type { RangeBundle } from '../api/types';
import {
  nextHistoricalFrom,
  stepChunkDays,
  planFillStep,
  earliestAllowedMinuteDate,
  todayKstYyyymmdd,
  PAST_CANDLES_MAX_DAYS,
} from './liveDateTime';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import MovingAverageOverlay from './indicators/MovingAverageOverlay';
import AuctionWindowOverlay from '../chart/AuctionWindowOverlay';
import DrawingOverlay from '../chart/DrawingOverlay';
import DrawingPropertyPanel from '../chart/DrawingPropertyPanel';
import PaneLegendOverlay from './PaneLegendOverlay';
import type { PaneId } from '../chart/drawing/types';
import { useDrawingHost } from '../chart/useDrawingHost';

const TOKEN_SPEC = {
  bgCard: ['--bg-card', '#13131C'],
  fg: ['--fg', '#E2E8F0'],
  grid: ['--grid', '#1A1A26'],
  border: ['--border', '#1F1F2A'],
} as const;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 진행 루프 무한 방지 백스톱. 250일 클램프(≈50스텝 @ 5캘린더일)가 먼저 멈추므로
 * 이건 백스톱-of-백스톱(60×5=300일 > 250일). */
const MAX_FILL_STEPS = 60;

/** Empty axis used while the bundle is loading. timeFormatter / tickMarkFormatter
 * read through `axisRef.current` to convert virtual seconds back to real KST;
 * before the real axis arrives they need a working `.toReal()` to return
 * something that doesn't crash. Mirrors ChartStage's `axisRef` pattern. */
const EMPTY_AXIS: VirtualAxis = createVirtualAxis([]);

interface Props {
  code: string | null;
  timeframe: LiveTimeframe;
  bundle: RangeBundle | null;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
  /** useLiveBundle.isExtending. false-edge = 한 스텝 settle → 진행 루프 다음 스텝 판정. */
  isExtending?: boolean;
}

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

/** /live's single-chart root. Mounts the timeframe-appropriate pane set
 * (see `paneSpecsForTimeframe`) inside one createChart instance so
 * timeScale is shared across candle/volume/(hoga) panes. */
export function LiveChartRoot({ code, timeframe, bundle, clampEngaged, isPastCandlesLoading, isExtending = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);

  // Eng review C1: memoise VirtualAxis on the segments array reference so
  // an SSE push that doesn't change segments doesn't churn the axis identity.
  const axis: VirtualAxis = useMemo(() => {
    if (!bundle || bundle.segments.length === 0) return EMPTY_AXIS;
    return createVirtualAxis(
      bundle.segments.map((s) => ({
        date: s.date,
        sessionOpenMs: s.session_open_ms,
        sessionCloseMs: s.session_close_ms,
      })),
    );
  }, [bundle?.segments]);

  // Drawing-host concerns (paneSeries registry, activeCode binding,
  // panel-anchor computation) live in their own hook so this file stays
  // focused on chart bootstrap, viewport policy, and overlay mounts.
  const { paneSeries, registerPaneSeries, unregisterPaneSeries, computeAnchor } =
    useDrawingHost(chart, axis, code, containerRef);

  // axisRef / timeframeRef bridge the latest axis + timeframe to the
  // once-mounted chart's imperative callbacks (the timeFormatter +
  // tickMarkFormatter, and the injected KST HorzScaleBehavior's
  // fillWeightsForPoints) without re-creating the chart.
  //
  // These MUST be written synchronously during render, NOT in a useEffect.
  // Child panes push setData in their own effects, and child effects fire
  // BEFORE a parent effect. fillWeightsForPoints runs inside that child
  // setData, so an effect-deferred axisRef would still hold the PREVIOUS axis
  // on the commit that first pushes a new timeframe's candles — mapping the new
  // candles' virtual times through the old (smaller-range) axis clamps them all
  // to one real time → identical KST dates → intraday weights → the calendar
  // axis suppresses every Time tick → blank x-axis until refresh (regression
  // test: "timeframe-switch axis freshness"). A render-time write is current
  // before any child renders/effects. Safe because these refs are read only by
  // imperative chart callbacks, never to produce render output (idempotent
  // under StrictMode double-render).
  const axisRef: MutableRefObject<VirtualAxis> = useRef<VirtualAxis>(axis);
  axisRef.current = axis;
  const timeframeRef: MutableRefObject<LiveTimeframe> = useRef<LiveTimeframe>(timeframe);
  timeframeRef.current = timeframe;

  // Publish axis to the shared store so LiveSidebar can read
  // axis.inClosingAuctionWindow(cursorMs) for TotalQtyBar mask.
  useEffect(() => {
    useLiveAxisStore.getState().setAxis(axis);
    return () => {
      useLiveAxisStore.getState().setAxis(null);
    };
  }, [axis]);

  // Viewport policy: trading-chart standard. Initial paint shows the
  // most recent INITIAL_VISIBLE_BARS candles (so today and recent past are
  // legible at native scale); series carries the full
  // initialHistoricalDaysFor(timeframe) window in memory. User drags left
  // to reveal more past — and when they drag past the leftmost loaded bar,
  // the chunked-extension fetch fires (see lazy-fetch trigger below).
  //
  // Without this, fitContent on a 20-day seed compresses today (≈30 1m
  // candles) into ~0.7% of the viewport — visually invisible. The whole
  // point of having today at all is to be the focus on first paint.
  //
  // Re-set the visible range only when (code, timeframe) changes — NOT on
  // every bundle update. SSE pushes inside today's segment must not snap
  // the user's scroll. The user-extended condition (historicalFromDate !=
  // null) also short-circuits — chunked extension lands silently.
  // Tracks the bundle.candles.length at which we last applied the initial
  // viewport for this (code, timeframe). null = not yet applied.
  // Minute paths apply once; D/W/M re-apply when the count grows so the
  // 20-day initial fetch (~14 bars) → 250-day extension fetch (~250 bars)
  // transition doesn't leave the chart zoomed on the early window with the
  // latest data off the right edge.
  const lastAppliedCountRef = useRef<number | null>(null);
  // Historical-prepend viewport preservation (see the restore effect below).
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
    lastAppliedCountRef.current = null;
    prevEarliestTsMsRef.current = null;
    viewportShiftRef.current = null;
    fillStepCountRef.current = 0;
    prevExtendingRef.current = false;
  }, [code, timeframe]);
  useEffect(() => {
    if (!chart || !bundle || bundle.candles.length === 0) return;
    if (useLivePageStore.getState().historicalFromDate !== null) return;
    const ts = chart.timeScale();
    const totalBars = bundle.candles.length;
    const applied = lastAppliedCountRef.current;
    try {
      if (isMinuteTimeframe(timeframe)) {
        // Minute timeframes carry ~5000 1m bars and need 300-bar windowing
        // to stay legible. Apply once per (code, timeframe): SSE pushes
        // inside today's segment must not snap the user's scroll.
        if (applied !== null) return;
        const target = 300;
        const from = Math.max(0, totalBars - target);
        const to = totalBars + 5; // 5-bar right padding
        ts.setVisibleLogicalRange({ from, to });
        // setVisibleLogicalRange alone does NOT actually pin the latest bar
        // to the right edge when CHART_TIMESCALE_OPTIONS.rightOffset is set
        // and a previous (code, timeframe)'s bar layout is cached on the
        // chart instance. The library reports getVisibleLogicalRange() ==
        // what we set, but timeToCoordinate(lastBar) falls past chart.width
        // — verified 2026-05-29 with rightOffset=15. scrollToPosition(0,
        // false) explicitly snaps the right edge to the latest bar +
        // rightOffset gap, which is what users expect ("most recent candle
        // near the right"). One-shot via lastAppliedCountRef so SSE pushes
        // still preserve user scroll.
        ts.scrollToPosition(0, false);
        lastAppliedCountRef.current = totalBars;
      } else {
        // D/W/M re-fit only when totalBars grows beyond the count at which
        // we last fitted. The 14 → ~250 bar growth from the daily-fetch
        // extension would otherwise be invisible. historicalFromDate !== null
        // (user-driven extension) short-circuits above, so user scroll is
        // preserved.
        if (applied !== null && totalBars <= applied) return;
        ts.fitContent();
        lastAppliedCountRef.current = totalBars;
      }
    } catch {
      // chart torn down between effect runs
    }
  }, [chart, bundle, timeframe]);

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
  // close it). Complementary to the initial-view effect above via
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
    // Initial paint and SSE growth are owned by the initial-view effect above;
    // only the user-driven extension path corrects the viewport here.
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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const tokens = resolveTokens(TOKEN_SPEC);
    // Explicit generics pin HorzScaleItem=Time: without them createChartEx
    // infers `unknown` and the IHorzScaleBehavior<Time> instance no longer
    // matches. The behavior's options() override (TimeChartOptions) is what
    // makes timeScale.tickMarkFormatter typecheck below.
    const c = createChartEx<Time, ReturnType<typeof createKstHorzScaleBehavior>>(
      el,
      createKstHorzScaleBehavior(axisRef),
      {
      ...CHART_LAYOUT_OPTIONS,
      width: el.clientWidth,
      height: el.clientHeight,
      layout: { background: { color: tokens.bgCard }, textColor: tokens.fg },
      grid: { vertLines: { color: tokens.grid }, horzLines: { color: tokens.grid } },
      crosshair: CHART_CROSSHAIR_OPTIONS,
      // Virtual axis: lightweight-charts treats time values as Unix seconds,
      // but our values are virtual-ms offsets from segments[0].sessionOpenMs.
      // Both formatters convert virtual → real ms via axisRef.current.toReal,
      // then format in KST (UTC+9). Mirrors ChartStage's setup.
      localization: {
        timeFormatter: (time: Time): string => {
          const virtualMs = (time as number) * 1000;
          const a = axisRef.current;
          if (a.segments.length === 0) return '';
          const realMs = a.toReal(virtualMs);
          const d = new Date(realMs + 9 * 3600_000);
          // D/W/M candles are all anchored to 09:00 KST — appending the time
          // to the crosshair tooltip would be misleading ("did the daily bar
          // happen at 09:00?"), so the tooltip stays date-only there.
          if (isCalendarTimeframe(timeframeRef.current)) {
            return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
          }
          return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        },
      },
      timeScale: {
        ...CHART_TIMESCALE_OPTIONS,
        timeVisible: true,
        secondsVisible: false,
        borderColor: tokens.border,
        tickMarkFormatter: (time: UTCTimestamp, tickType: TickMarkType): string => {
          const virtualMs = (time as number) * 1000;
          const a = axisRef.current;
          if (a.segments.length === 0) return '';
          const realMs = a.toReal(virtualMs);
          const d = new Date(realMs + 9 * 3600_000);
          const calendar = isCalendarTimeframe(timeframeRef.current);
          // Weights now follow the real KST calendar (see kstHorzScaleBehavior),
          // so tickType is trustworthy: month boundaries get Month, day
          // boundaries get DayOfMonth, intraday gets Time. We just format.
          // Calendar (D/W/M) bars are all anchored to 09:00 KST, so their
          // intraday Time tiers carry no meaning and are suppressed.
          const hhmm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
          switch (tickType) {
            case TickMarkType.Year:
              return `'${String(d.getUTCFullYear()).slice(-2)}`;
            case TickMarkType.Month:
              return `${d.getUTCMonth() + 1}월`;
            case TickMarkType.DayOfMonth:
              return `${d.getUTCDate()}`;
            case TickMarkType.Time:
              return calendar ? '' : hhmm;
            case TickMarkType.TimeWithSeconds:
              return calendar ? '' : `${hhmm}:${pad(d.getUTCSeconds())}`;
            default:
              return '';
          }
        },
      },
      rightPriceScale: { borderColor: tokens.border },
      autoSize: true,
    });
    setChart(c as IChartApi);
    // autoSize: true already attaches lightweight-charts' own ResizeObserver
    // to the container — an extra manual observer here just produces the
    // "Height and width values ignored because 'autoSize' option is enabled"
    // warning on every resize without affecting layout.
    // [TEMP-DIAG-VIEWPORT] dev-only QA handles for the in-browser repro.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __liveChart?: unknown; __liveAxisGet?: unknown };
      w.__liveChart = c;
      w.__liveAxisGet = () => useLiveAxisStore.getState().axis;
    }

    return () => {
      c.remove();
      setChart(null);
    };
  }, []);

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
  //
  // Base date: prefer the already-requested historicalFromDate over the
  // axis earliest. When a chunk lands on a holiday-only span (e.g. Lunar
  // New Year), axis.segments[0] stays put — so basing off axis would have
  // the next trigger recompute the same target, the store guard would
  // reject it, and extension would freeze. Basing off historicalFromDate
  // instead means each pan-past steps another chunk back regardless of
  // whether the server returned new trading days for the prior chunk.
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

  const foreignNetEnabled = useLivePageStore((s) => s.foreignNetEnabled);
  const institutionNetEnabled = useLivePageStore((s) => s.institutionNetEnabled);
  const volumeEnabled = useLivePageStore((s) => s.volumeEnabled);

  useEffect(() => {
    if (!chart || !bundle) return;
    const specs = paneSpecsForTimeframe(timeframe, {
      foreignNet: foreignNetEnabled,
      institutionNet: institutionNetEnabled,
      volumeEnabled,
    });
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      try {
        const panes = chart.panes();
        if (panes.length < specs.length) {
          requestAnimationFrame(apply);
          return;
        }
        panes.forEach((p, i) => {
          const f = specs[i]?.stretch;
          if (f !== undefined && typeof p.setStretchFactor === 'function') {
            p.setStretchFactor(f);
          }
        });
      } catch {
        // chart tearing down
      }
    };
    const raf = requestAnimationFrame(apply);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [chart, bundle, timeframe, foreignNetEnabled, institutionNetEnabled, volumeEnabled]);

  // ADR-0044: hover → cursor store. Only mount on minute timeframes —
  // calendar timeframes (D/W/M) don't have backing parquet on /live.
  // rAF-coalesce to one update per frame (matches ChartStage's pattern).
  useEffect(() => {
    // Publish cursor on ALL timeframes (Pane Legend reads it on D too). Spot-mode
    // entry stays minute-only — gated on the LiveSidebar consumer side (ADR-0044).
    if (!chart) {
      useLiveCursorStore.getState().clearCursor();
      return;
    }
    let pending: number | null = null;
    const handler = (param: { time?: unknown; point?: { x: number } | null }) => {
      if (param.point == null) {
        if (pending !== null) { cancelAnimationFrame(pending); pending = null; }
        useLiveCursorStore.getState().clearCursor();
        return;
      }
      if (pending !== null) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        pending = null;
        const t = param.time;
        if (typeof t !== 'number') return;
        // ChartStage.tsx:197 pattern — param.time is virtual-axis seconds.
        // Convert to virtual-ms, then real Unix-ms via axis.toReal().
        if (axis.segments.length === 0) return;
        const virtualMs = t * 1000;
        const realMs = axis.toReal(virtualMs);
        useLiveCursorStore.getState().setCursor(realMs);
      });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      if (pending !== null) cancelAnimationFrame(pending);
      useLiveCursorStore.getState().clearCursor();
    };
  }, [chart, axis, timeframe]);

  const dwDisabled = isCalendarTimeframe(timeframe);

  return (
    <div
      data-testid="live-chart-root"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', background: 'var(--bg-card)' }}
      />
      {chart && bundle && axis.segments.length > 0 && (
        <>
          {paneSpecsForTimeframe(timeframe, {
            foreignNet: foreignNetEnabled,
            institutionNet: institutionNetEnabled,
            volumeEnabled,
          }).map((spec, i) => (
            <RangeSeriesPane
              key={spec.name}
              chart={chart}
              bundle={bundle}
              axis={axis}
              paneIndex={i}
              spec={spec}
              onPrimarySeriesReady={(s) => registerPaneSeries(spec.name as PaneId, s)}
              onPrimarySeriesGone={() => unregisterPaneSeries(spec.name as PaneId)}
            />
          ))}
          <MovingAverageOverlay chart={chart} bundle={bundle} axis={axis} />
          <DrawingOverlay chart={chart} axis={axis} paneSeries={paneSeries} />
          {/* After DrawingOverlay so the legend's ✕/eye buttons paint above the
              drawing canvas; the container is pointer-transparent so the
              crosshair + drawing hover still work underneath it. */}
          <PaneLegendOverlay chart={chart} timeframe={timeframe} paneSeries={paneSeries} />
          <DrawingPropertyPanel computeAnchor={computeAnchor} />
          {/* Day boundary lines only make sense on intraday timeframes —
              D/W/M's candles are already day/week/month units, so a
              per-day vertical line collapses onto each candle. */}
          {isMinuteTimeframe(timeframe) && (
            <DayBoundaryOverlay chart={chart} axis={axis} />
          )}
          {/* Auction-window mask shading — self-gates on
              useActivePrefs(auctionWindowMask) (default ON) and on
              axis.segments.length > 0, so safe on D/W/M too. Gives
              visual parity (gray band over 15:20–15:30 KST) with the
              data masking the same toggle applies to RatioPane /
              FillStrength / TotalQtyBar. */}
          <AuctionWindowOverlay chart={chart} axis={axis} />
        </>
      )}
      {dwDisabled && (
        <div
          data-testid="indicator-disabled-note"
          style={{
            position: 'absolute',
            top: 'var(--space-md)',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: 'var(--space-xs) var(--space-md)',
            background: 'var(--bg-subtle)',
            color: 'var(--fg-dimmer)',
            fontSize: 'var(--text-xs)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            pointerEvents: 'none',
          }}
        >
          라이브 지표는 분봉에서 표시됩니다
        </div>
      )}
      {isPastCandlesLoading && (!bundle || bundle.candles.length === 0) && (
        <div
          data-testid="past-candles-loading-note"
          style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', color: 'var(--fg-dimmer)',
            fontSize: 'var(--text-sm)',
          }}
        >
          분봉 불러오는 중…
        </div>
      )}
      {clampEngaged && (
        <div
          data-testid="clamp-engaged-chip"
          style={{
            position: 'absolute', bottom: 'var(--space-md)', left: 'var(--space-md)',
            padding: 'var(--space-xs) var(--space-md)',
            background: 'var(--bg-subtle)', color: 'var(--fg-dimmer)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-xs)',
            pointerEvents: 'none',
          }}
        >
          최대 {PAST_CANDLES_MAX_DAYS}일까지 표시됩니다
        </div>
      )}
    </div>
  );
}

export default LiveChartRoot;
