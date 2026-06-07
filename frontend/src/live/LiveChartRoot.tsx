import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  createChartEx,
  TickMarkType,
  type IChartApi,
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
import { PAST_CANDLES_MAX_DAYS } from './liveDateTime';
import { useViewportBackfill } from './useViewportBackfill';
import { useWheelInteractions } from './useWheelInteractions';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import MovingAverageOverlay from './indicators/MovingAverageOverlay';
import LiveCurrentPriceLine from './LiveCurrentPriceLine';
import AuctionWindowOverlay from '../chart/AuctionWindowOverlay';
import DrawingOverlay from '../chart/DrawingOverlay';
import DrawingPropertyPanel from '../chart/DrawingPropertyPanel';
import PaneLegendOverlay from './PaneLegendOverlay';
import CandleTooltip from './CandleTooltip';
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

/** /live's single-chart root. Mounts the timeframe-appropriate pane set
 * (see `paneSpecsForTimeframe`) inside one createChart instance so
 * timeScale is shared across candle/volume/(hoga) panes. */
export function LiveChartRoot({ code, timeframe, bundle, clampEngaged, isPastCandlesLoading, isExtending = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Load identity for the per-view chart remount and the reveal cover.
  const viewKey = `${code ?? ''}|${timeframe}`;
  // Chart identity is KEYED by the view it was created for. On a viewKey
  // switch, React runs all cleanups then all setups within one commit, but
  // effects created by THAT render still close over the previous chart state
  // — which now references the chart the creation-effect cleanup already
  // remove()d. lwc 5.2.0 viewport calls on a removed chart do not throw
  // (they only queue an invalidation), so without this gate the initial-view
  // effect would consume its one-shot `lastAppliedCountRef` against the dead
  // instance, schedule the reveal early, and leave the NEW chart at lwc's
  // default ~60-bar viewport (adversarial review F1, proven with a two-chart
  // mock). Deriving `chart` as null whenever the entry's key disagrees with
  // the current viewKey makes every consumer effect no-op for exactly that
  // one mismatched commit; the creation effect then publishes the new
  // instance under the new key.
  const [chartEntry, setChartEntry] = useState<{ chart: IChartApi; key: string } | null>(null);
  const chart = chartEntry !== null && chartEntry.key === viewKey ? chartEntry.chart : null;

  // Eng review C1: memoise VirtualAxis on the segments array reference so
  // an SSE push that doesn't change segments doesn't churn the axis identity.
  //
  // Real-anchored origin (2nd arg): within this (code, timeframe) view, the
  // candle `time` values lwc holds change at index 0 whenever segments[0]
  // moves (leftward-pan prepend) and stay stable otherwise — defeating lwc's
  // value-keyed tick weight/label retention. Mechanism + edge cases live on
  // createVirtualAxis's originMs doc; cross-view collisions are handled by
  // the per-viewKey chart remount below.
  const axis: VirtualAxis = useMemo(() => {
    if (!bundle || bundle.segments.length === 0) return EMPTY_AXIS;
    return createVirtualAxis(
      bundle.segments.map((s) => ({
        date: s.date,
        sessionOpenMs: s.session_open_ms,
        sessionCloseMs: s.session_close_ms,
      })),
      bundle.segments[0].session_open_ms,
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
  // Cold-load reveal gate. On a cold (code, timeframe) load the hoga panes
  // (/api/range) resolve up to ~2.5s before the candles (/api/live/past-candles
  // carries ~40 days) and establish lightweight-charts' default ~60-bar fit on
  // the shared timeScale; when the candles land, the initial-view effect below
  // re-applies the 300-bar window — but lwc paints a visible-WIDTH (barSpacing)
  // change one frame LATE (verified 2026-06-05 via cold-load frame traces:
  // setVisibleLogicalRange lands on frame N, the new barSpacing paints on N+1).
  // So the candles flash in zoomed to ~60 bars and then zoom out to ~300 — the
  // "drawn twice" feeling. We keep `chartReady` false (an opaque cover masks the
  // chart) from the switch until two rAFs after the viewport is applied
  // (barSpacing settled), then fade the cover out so the candles appear once,
  // already at the final zoom. Warm switches reveal in ~2 frames, so the fade is
  // imperceptible there.
  //
  // The reveal is keyed by load identity (viewKey, declared at the top with
  // the chart entry): `chartReady` is DERIVED (revealedKey === viewKey), not
  // reset in an effect, so a watchlist switch re-masks synchronously with the
  // new props — no extra render and no one-frame glimpse of the previous
  // code's candles. The key also makes the reveal scheduler idempotent across
  // SSE bundle churn (revealedKey already === viewKey short-circuits).
  // `revealRafRef` lets the key-change effect cancel a still-pending reveal.
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const revealRafRef = useRef<number | null>(null);
  const chartReady = revealedKey === viewKey;
  useEffect(() => {
    lastAppliedCountRef.current = null;
    if (revealRafRef.current !== null) {
      cancelAnimationFrame(revealRafRef.current);
      revealRafRef.current = null;
    }
  }, [code, timeframe]);
  // Cancel a pending reveal rAF on unmount so it can't setState after teardown.
  useEffect(() => () => {
    if (revealRafRef.current !== null) cancelAnimationFrame(revealRafRef.current);
  }, []);

  // Leftward-pan historical backfill + staleness-free viewport repositioning
  // (pre-swap layout snapshot, post-setData reposition, lazy-fetch trigger,
  // settle-loop) live in this headless controller. Called from the parent so
  // its layout snapshot runs before — and its repositioner after —
  // RangeSeriesPane's child setData within the same bundle commit. The
  // repositioner and the initial-view effect below are mutually exclusive via
  // historicalFromDate (null → initial-view owns the viewport; non-null →
  // repositioner), so their relative declaration order is immaterial.
  useViewportBackfill({ chart, axis, bundle, timeframe, isExtending, code: code ?? '' });
  // Modifier-aware 휠 줌/팬 — handleScale.mouseWheel: false(아래 createChartEx
  // 옵션)와 한 쌍. 스펙: docs/superpowers/specs/2026-06-07-live-wheel-interactions-design.md
  useWheelInteractions(chart, containerRef, bundle);
  useEffect(() => {
    // Reveal the chart two rAFs after the viewport is applied, so lightweight-
    // charts' one-frame-late barSpacing settle (the cold-load zoom flash) lands
    // behind the still-opaque cover. Idempotent across SSE bundle churn (the
    // revealedKey === viewKey guard); a second rAF guarantees the width has
    // painted before fade-in.
    const reveal = () => {
      if (revealedKey === viewKey || revealRafRef.current !== null) return;
      revealRafRef.current = requestAnimationFrame(() => {
        revealRafRef.current = requestAnimationFrame(() => {
          revealRafRef.current = null;
          setRevealedKey(viewKey);
        });
      });
    };
    if (!chart || !bundle) {
      // No chart/bundle to position yet. If the past-candle fetch has SETTLED
      // with no bundle to show (no active code / null bundle), reveal anyway so
      // the cover can't wedge opaque over a chartless surface; while still
      // loading, keep it up. Safe against a re-flash: a null bundle means no
      // candle data is pending, so nothing can later paint at the wrong zoom.
      if (chart && !isPastCandlesLoading) reveal();
      return;
    }
    if (bundle.candles.length === 0) {
      // No candles yet. If the past-candle fetch has settled (empty result, or
      // D/W/M with no history), reveal the empty chart so the cover doesn't
      // linger; while it's still loading, keep the cover up.
      if (!isPastCandlesLoading) reveal();
      return;
    }
    if (useLivePageStore.getState().historicalFromDate !== null) {
      // User-driven extension owns the viewport (prepend-restore); the chart was
      // already revealed on the initial load, so nothing to schedule here.
      //
      // historicalFromDate is read via getState() (not an effect dep) on purpose:
      // it only flips non-null AFTER the initial reveal (a leftward pan), and
      // setActiveCode / setCandleTimeframe reset it to null — so a fresh
      // (code, timeframe) load always passes this gate and reveals. The reveal is
      // therefore never gated behind a value that's missing from the deps.
      return;
    }
    const ts = chart.timeScale();
    const totalBars = bundle.candles.length;
    const applied = lastAppliedCountRef.current;
    try {
      if (isMinuteTimeframe(timeframe)) {
        // Minute timeframes carry ~5000 1m bars and need 300-bar windowing
        // to stay legible. Apply once per (code, timeframe): SSE pushes
        // inside today's segment must not snap the user's scroll.
        if (applied !== null) { reveal(); return; }
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
        reveal();
      } else {
        // D/W/M re-fit only when totalBars grows beyond the count at which
        // we last fitted. The 14 → ~250 bar growth from the daily-fetch
        // extension would otherwise be invisible. historicalFromDate !== null
        // (user-driven extension) short-circuits above, so user scroll is
        // preserved.
        if (applied !== null && totalBars <= applied) { reveal(); return; }
        ts.fitContent();
        lastAppliedCountRef.current = totalBars;
        reveal();
      }
    } catch {
      // chart torn down between effect runs
    }
  }, [chart, bundle, timeframe, isPastCandlesLoading, viewKey, revealedKey]);

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
      // 라이브러리 내장 휠 줌(마우스 앵커) 비활성 — useWheelInteractions가 wheel을
      // 단독 소유한다(이중 소유권 레이스 방지). handleScale의 나머지 sub-option
      // (pinch, axisPressedMouseMove, axisDoubleClickReset)과 handleScroll(트랙패드
      // deltaX 팬)은 기본값 유지.
      handleScale: { mouseWheel: false },
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
    setChartEntry({ chart: c as IChartApi, key: viewKey });
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
      setChartEntry(null);
    };
    // Recreate the chart per (code, timeframe) view. lightweight-charts keeps
    // per-instance caches keyed by time VALUE (tick weights, marks, formatted
    // labels — see createVirtualAxis's originMs doc), and two different views
    // can legitimately produce value-identical time ladders with DIFFERENT
    // real-date mappings even under real-anchored origins: W↔M (or D↔W/M)
    // when both windows clamp to the same first trading day (any stock whose
    // history is shorter than both fetch windows), and code switches where
    // per-stock missing dates change the mapping but not the gap-compressed
    // ladder. No origin arithmetic can separate those — a fresh chart
    // instance is the only state boundary that guarantees no cross-view
    // carryover. Within one view, prepends are handled by the real-anchored
    // origin (segments[0] moves → full lwc rebuild). The viewKey reveal cover
    // already masks the swap, so remounting adds no visible flash.
  }, [viewKey]);

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
          <LiveCurrentPriceLine paneSeries={paneSeries} bundle={bundle} code={code} />
          <DrawingOverlay chart={chart} axis={axis} paneSeries={paneSeries} />
          {/* After DrawingOverlay so the legend's ✕/eye buttons paint above the
              drawing canvas; the container is pointer-transparent so the
              crosshair + drawing hover still work underneath it. */}
          <PaneLegendOverlay chart={chart} timeframe={timeframe} paneSeries={paneSeries} />
          <CandleTooltip chart={chart} bundle={bundle} axis={axis} paneSeries={paneSeries} timeframe={timeframe} />
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
      {/* Reveal cover — masks the chart + its overlays while the initial
          viewport's barSpacing settles (see chartReady gate above), then fades
          out so the candles appear once at the final zoom instead of flashing
          in at lightweight-charts' default ~60-bar fit and zooming out. Painted
          after the chart/overlay fragment (above it) but before the loading /
          clamp notes below (so those stay visible through the masked window).
          bg-card matches the chart background, so the cover reads as the empty
          chart surface during a cold load.

          The transition is asymmetric: it animates only on REVEAL (chartReady
          true → fade out). Masking (chartReady false, e.g. a watchlist switch)
          applies instantly so the previous code's candles are hidden in the
          same frame rather than lingering through a 160ms fade-to-opaque. */}
      <div
        data-testid="chart-reveal-cover"
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--bg-card)',
          opacity: chartReady ? 0 : 1,
          transition: chartReady ? 'opacity 0.16s ease-out' : 'none',
          pointerEvents: 'none',
        }}
      />
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
