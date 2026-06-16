import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  createChartEx,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
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
import type { AskPeak, RangeBundle } from '../api/types';
import { PAST_CANDLES_MAX_DAYS } from './liveDateTime';
import { summarizeWarnings, type LiveDataWarning } from './liveDataWarnings';
import { useViewportBackfill } from './useViewportBackfill';
import { registerViewportCapture, saveViewportToActiveTab } from '../state/liveTabs';
import {
  viewportFromRanges,
  computeRestoreRange,
  realMsToVirtualSeconds,
  type TabViewport,
} from './viewportAnchor';
import { useWheelInteractions } from './useWheelInteractions';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import MovingAverageOverlay from './indicators/MovingAverageOverlay';
import DailyMovingAverageOverlay from './indicators/DailyMovingAverageOverlay';
import LiveCurrentPriceLine from './LiveCurrentPriceLine';
import LiveAskPeakSegments from './LiveAskPeakSegments';
import AuctionWindowOverlay from '../chart/AuctionWindowOverlay';
import DrawingOverlay from '../chart/DrawingOverlay';
import DrawingPropertyPanel from '../chart/DrawingPropertyPanel';
import PaneLegendOverlay from './PaneLegendOverlay';
import CandleTooltip from './CandleTooltip';
import HighLowAnnotationOverlay from './HighLowAnnotationOverlay';
import type { PaneId } from '../chart/drawing/types';
import { useDrawingHost } from '../chart/useDrawingHost';
import type { StudySnapshotRangeBundle } from '../studyViews/studySnapshotAdapter';

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
/** 안정 빈 배열 — 기본값이 매 렌더 새 []를 만들지 않게. */
const EMPTY_ASK_PEAKS: readonly AskPeak[] = [];

interface Props {
  code: string | null;
  timeframe: LiveTimeframe;
  /** Optional view-level identity for same-code/timeframe restores (for example `/study?view=...`). */
  viewIdentity?: string;
  /** Full bundle = chart side + live hoga overlay (new ref each SSE tick).
   * Only the hoga panes (spec.live) consume it. */
  bundle: RangeBundle | null;
  /** Chart side only, STABLE across SSE ticks (2026-06-09 bundle-split, Phase A).
   * The candle/volume panes, axis, and candle overlays read this so an SSE tick
   * doesn't churn the candle path. Optional + falls back to `bundle` so existing
   * single-bundle callers/tests keep working unchanged. */
  chartBundle?: RangeBundle | null;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
  /** useLiveBundle.isExtending. false-edge = 한 스텝 settle → 진행 루프 다음 스텝 판정. */
  isExtending?: boolean;
  /** 활성 경로 과거 fetch 경고(rate-limit 등, useLiveBundle). 캔들 없으면 빈칸 문구를
   * "호출 한도로 지연"으로 전환, 캔들 있으면 비차단 "일부 과거구간 로딩 지연" 칩. 옵셔널
   * (기존 단일-번들 호출부/테스트 보존). */
  pastDataWarnings?: LiveDataWarning[];
  /** 활성 탭의 저장된 viewport(ADR-0069 A안). cold 전환 복귀 시 보던 위치(줌+스크롤)로
   *  복원한다. optional + 기본 null이라 기존 단일-번들 호출부/테스트는 무변경으로 동작. */
  restoreViewport?: TabViewport | null;
  /** LivePage의 useDayAskPeaks 결과(거래일별) — LiveAskPeakSegments에 전달. */
  dayAskPeaks?: readonly AskPeak[];
  /** 오늘(KST YYYYMMDD) — 오늘 세그먼트만 라이브 엣지까지 연장. */
  todayKst?: string;
  /** Snapshot restore can carry hoga panes on calendar timeframes. /live keeps the default gate. */
  forceHogaPanes?: boolean;
  /** Snapshot restore can pin pane mounts to saved indicator state. Omitted means read /live store. */
  paneTogglesOverride?: {
    volumeEnabled?: boolean;
    quoteTotalsEnabled?: boolean;
    ratioEnabled?: boolean;
    fillStrengthEnabled?: boolean;
  };
  /** /live persists viewport to active live tabs; snapshot study pages opt out. */
  persistLiveViewport?: boolean;
}

function withStudyRatioAsQuoteRatio(bundle: RangeBundle): RangeBundle {
  const studyRatio = (bundle as Partial<StudySnapshotRangeBundle>).study_ratio;
  if (!studyRatio || studyRatio.points.length === 0) return bundle;
  return {
    ...bundle,
    quote_ratio: {
      bucket_ms: studyRatio.bucket_ms,
      points: studyRatio.points.map((p) => {
        const bid_total = p.value >= 0 ? 1 : 1 - p.value;
        const ask_total = p.value >= 0 ? 1 + p.value : 1;
        return {
          t: p.t,
          bid_total,
          ask_total,
          bid_max: bid_total,
          ask_max: ask_total,
          imb_max_bid: bid_total,
          imb_max_ask: ask_total,
        };
      }),
    },
  };
}

/** /live's single-chart root. Mounts the timeframe-appropriate pane set
 * (see `paneSpecsForTimeframe`) inside one createChart instance so
 * timeScale is shared across candle/volume/(hoga) panes. */
export function LiveChartRoot({ code, timeframe, viewIdentity, bundle, chartBundle, clampEngaged, isPastCandlesLoading, isExtending = false, pastDataWarnings, restoreViewport = null, dayAskPeaks = EMPTY_ASK_PEAKS, todayKst = '', forceHogaPanes = false, paneTogglesOverride, persistLiveViewport = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 과거 fetch 경고 요약 — rate-limit 지연(빈칸 문구 전환)과 일부 구간 누락(부분로딩 칩)
  // 표시에 쓴다. summarizeWarnings는 null/빈배열을 {count:0,hasRateLimit:false}로 접는다.
  const warnSummary = summarizeWarnings(pastDataWarnings);
  // bottom-left 상태 칩 공유 스타일 (부분로딩 칩 + 클램프 칩 동일 형태, DRY).
  const chipStyle = {
    padding: 'var(--space-xs) var(--space-md)',
    background: 'var(--bg-subtle)', color: 'var(--fg-dimmer)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    fontSize: 'var(--text-xs)',
    pointerEvents: 'none' as const,
  };
  // Candle-path bundle: stable `chartBundle` when provided (the /live split),
  // else the single `bundle` (pre-split callers / tests). Axis, viewport,
  // candle/volume panes, and candle overlays all read THIS — never the live
  // `bundle` — so an SSE tick (which only changes the hoga overlay) leaves the
  // candle path's props referentially identical.
  const cb = chartBundle ?? bundle;
  const hogaBundle = bundle ?? cb;
  const ratioBundle = useMemo(() => hogaBundle ? withStudyRatioAsQuoteRatio(hogaBundle) : hogaBundle, [hogaBundle]);
  // Load identity for the per-view chart remount and the reveal cover.
  const viewKey = viewIdentity ? `${code ?? ''}|${timeframe}|${viewIdentity}` : `${code ?? ''}|${timeframe}`;
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
    if (!cb || cb.segments.length === 0) return EMPTY_AXIS;
    return createVirtualAxis(
      cb.segments.map((s) => ({
        date: s.date,
        sessionOpenMs: s.session_open_ms,
        sessionCloseMs: s.session_close_ms,
      })),
      cb.segments[0].session_open_ms,
    );
  }, [cb?.segments]);

  // Drawing-host concerns (paneSeries registry, activeCode binding,
  // panel-anchor computation) live in their own hook so this file stays
  // focused on chart bootstrap, viewport policy, and overlay mounts.
  const { paneSeries, registerPaneSeries, unregisterPaneSeries, computeAnchor } =
    useDrawingHost(chart, axis, code, containerRef);
  // Stable per-(un)register callbacks so RangeSeriesPane's React.memo (Phase B)
  // can skip candle/volume panes on an SSE tick. RangeSeriesPane passes the
  // pane name back, so one callback serves all panes (vs a per-pane closure that
  // would be a fresh function every render and defeat memo). register/unregister
  // are already stable (useCallback in useDrawingHost).
  const handleSeriesReady = useCallback(
    (s: ISeriesApi<any>, name: string) => registerPaneSeries(name as PaneId, s),
    [registerPaneSeries],
  );
  const handleSeriesGone = useCallback(
    (name: string) => unregisterPaneSeries(name as PaneId),
    [unregisterPaneSeries],
  );

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
  // Last real candle's real-ms, read by the crosshair handler to detect the
  // right-offset whitespace (cursor past the last bar) without making the
  // handler effect depend on every SSE bundle. Written during render (like
  // axisRef) so it's current before any child effect; null when no candles.
  const lastCandleMsRef = useRef<number | null>(null);
  lastCandleMsRef.current =
    cb && cb.candles.length > 0 ? cb.candles[cb.candles.length - 1].ts_ms : null;

  // chartRef bridges the live chart instance to the viewport-capture callback
  // (registered once, reads refs) so the tabs store can snapshot the OUTGOING
  // tab's view synchronously on switch-away, before the per-viewKey remount.
  // Written during render (like axisRef) so it's current before any effect.
  const chartRef = useRef<IChartApi | null>(chart);
  chartRef.current = chart;

  // Viewport capture (ADR-0069 A안): read the live chart's visible range + zoom
  // and pin them to a real-time anchor. The tabs store calls this on switch-away
  // (focusTab / openOrFocusTab) to save the outgoing tab's view. Stable identity
  // (refs only) so the registration effect runs once.
  const captureViewport = useCallback((): TabViewport | null => {
    const c = chartRef.current;
    if (!c) return null;
    try {
      const ts = c.timeScale();
      return viewportFromRanges(
        ts.getVisibleLogicalRange(),
        ts.getVisibleRange(),
        axisRef.current,
        lastCandleMsRef.current,
      );
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    if (!persistLiveViewport) return;
    return registerViewportCapture(captureViewport);
  }, [captureViewport, persistLiveViewport]);

  // Continuous viewport capture (ADR-0069 A안 보강). focusTab/addBlankTab snapshot
  // the OUTGOING tab synchronously on a tab switch, but route navigation (leaving
  // /live) and a full reload never go through those — so the last-seen zoom/scroll
  // was lost on switch-back from another page. Subscribing to visible-range changes
  // and persisting (debounced) to the active tab backstops EVERY exit path.
  //
  // Trailing timeout debounce (NOT rAF): a save rewrites the active tab's `viewport`
  // (a new ref on LivePage's `tabs.find().viewport` → LiveChartRoot re-render) and
  // wakes attachPersistence's own 250ms localStorage write. rAF-frequency would do
  // that every frame mid-zoom; one save per gesture-settle is enough — tab switches
  // are already captured synchronously, so this only needs to cover route-nav/reload
  // where ~1 gesture of staleness is imperceptible.
  //
  // Guard: lastAppliedCountRef===null means the initial-view / restore effect hasn't
  // applied yet (the chart still sits at lightweight-charts' default ~60-bar fit) —
  // skip so that cold-load garbage isn't persisted as the user's view. After
  // application the first range-change saves the applied (restored/default) view
  // itself, which is idempotent and harmless.
  useEffect(() => {
    if (!persistLiveViewport) return;
    if (!chart) return;
    const ts = chart.timeScale();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSaved: { barSpan: number; atLiveEdge: boolean } | null = null;
    const save = () => {
      const vp = captureViewport();
      if (!vp) return;
      // Dedup the live-edge tick storm. During market hours a forming bar's setData
      // can fire range-change many times/sec; at the live edge that only drifts
      // rightEdgeMs while barSpan/atLiveEdge hold — and an atLiveEdge restore IGNORES
      // rightEdgeMs (it pins the latest bar), so persisting it is a pure store-write +
      // re-render with no recoverable information. Skip only that case. A zoom/scroll
      // changes barSpan; leaving/returning to the live edge flips atLiveEdge; a
      // scrolled-back pan keeps atLiveEdge=false so it always saves (its rightEdgeMs
      // IS the restore anchor) — all still captured.
      if (lastSaved && vp.atLiveEdge && lastSaved.atLiveEdge && lastSaved.barSpan === vp.barSpan) return;
      lastSaved = { barSpan: vp.barSpan, atLiveEdge: vp.atLiveEdge };
      saveViewportToActiveTab(vp);
    };
    const onRangeChange = () => {
      if (lastAppliedCountRef.current === null) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; save(); }, 250);
    };
    ts.subscribeVisibleLogicalRangeChange(onRangeChange);
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(onRangeChange);
      // Flush a pending capture on unmount (route-nav leaving /live) so the last
      // gesture isn't lost inside the debounce window — the route-nav reset bug.
      // captureViewport() directly (not the registry) so it can't race the
      // registerViewportCapture teardown; a removed chart try/catches to null →
      // saveViewportToActiveTab no-ops. This cleanup runs before the chart-create
      // effect's c.remove() (declared earlier), so the chart is still alive here.
      if (timer) {
        clearTimeout(timer);
        save();
      }
    };
  }, [chart, captureViewport, persistLiveViewport]);

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
  }, [viewKey]);
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
  useViewportBackfill({ chart, axis, bundle: cb, timeframe, isExtending, code: code ?? '' });
  // Modifier-aware 휠 줌/팬 — handleScale.mouseWheel: false(아래 createChartEx
  // 옵션)와 한 쌍. 스펙: docs/superpowers/specs/2026-06-07-live-wheel-interactions-design.md
  useWheelInteractions(chart, containerRef, cb, axis);
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
    if (!chart || !cb) {
      // No chart/bundle to position yet. If the past-candle fetch has SETTLED
      // with no bundle to show (no active code / null bundle), reveal anyway so
      // the cover can't wedge opaque over a chartless surface; while still
      // loading, keep it up. Safe against a re-flash: a null bundle means no
      // candle data is pending, so nothing can later paint at the wrong zoom.
      if (chart && !isPastCandlesLoading) reveal();
      return;
    }
    if (cb.candles.length === 0) {
      // No candles yet. If the past-candle fetch has settled (empty result, or
      // D/W/M with no history), reveal the empty chart so the cover doesn't
      // linger; while it's still loading, keep the cover up.
      if (!isPastCandlesLoading) reveal();
      return;
    }
    // A안 (ADR-0069): a tab carrying a saved viewport restores its exact view on
    // cold switch-back. Reproject the time anchor through the REBUILT axis →
    // logical index, re-apply the saved zoom (computeRestoreRange clamps the
    // applied from to >= 0). One-shot via lastAppliedCountRef (like the minute
    // branch) so SSE pushes don't re-snap. Runs BEFORE the historicalFromDate
    // gate so a scrolled-back tab (hfd != null) also restores and reveals here.
    if (restoreViewport && lastAppliedCountRef.current === null) {
      const tsR = chart.timeScale();
      const totalBarsR = cb.candles.length;
      try {
        // Anchor older than the earliest LOADED bar (a deep scrollback whose
        // backfill hasn't landed yet at this first-candle commit): lwc's
        // timeToIndex(findNearest=true) CLAMPS to bar 0 rather than returning
        // null (verified vs lwc 5.2.0), which would make computeRestoreRange
        // pin a degenerate {from:0,to:0} window. Gate the lookup on the anchor
        // being within loaded data so an off-left anchor yields idx=null →
        // null range → fall through to the default view. (cb.candles is
        // ascending, so [0] is the earliest.)
        const anchorInRange =
          !restoreViewport.atLiveEdge &&
          restoreViewport.rightEdgeMs >= cb.candles[0].ts_ms;
        const idx = anchorInRange
          ? tsR.timeToIndex(
              realMsToVirtualSeconds(axisRef.current, restoreViewport.rightEdgeMs) as Time,
              true,
            )
          : null;
        const range = computeRestoreRange(restoreViewport, totalBarsR, idx);
        if (range) {
          tsR.setVisibleLogicalRange({ from: range.from, to: range.to });
          if (range.scrollToRight) tsR.scrollToPosition(0, false);
          lastAppliedCountRef.current = totalBarsR;
          reveal();
          return;
        }
        // range null (anchor fell outside the rebuilt axis, not live-edge) →
        // fall through to the default initial view below.
      } catch {
        // chart torn down / API threw → fall through to default initial view.
      }
    }
    if (useLivePageStore.getState().historicalFromDate !== null) {
      // User-driven extension owns the viewport (prepend-restore is handled by
      // useViewportBackfill). REVEAL so the cover lifts: on an IN-SESSION pan the
      // chart was already revealed (reveal() no-ops via the revealedKey guard);
      // on a COLD restore of a scrolled-back tab WITHOUT a saved viewport
      // (migrated tab, or viewport cleared by a timeframe change) the restore
      // branch above didn't run, so this is the only reveal — without it the
      // opaque cover wedges over the chart (the historicalFromDate-gate bug).
      //
      // historicalFromDate is read via getState() (not an effect dep) on purpose:
      // setActiveCode / setCandleTimeframe reset it to null, so a fresh
      // (code, timeframe) load always passes this gate; it only flips non-null
      // after a pan, when the chart is already revealed.
      reveal();
      return;
    }
    const ts = chart.timeScale();
    const totalBars = cb.candles.length;
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
  }, [chart, cb, timeframe, isPastCandlesLoading, viewKey, revealedKey, restoreViewport]);

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
  const quoteTotalsEnabled = useLivePageStore((s) => s.quoteTotalsEnabled);
  const ratioEnabled = useLivePageStore((s) => s.ratioEnabled);
  const fillStrengthEnabled = useLivePageStore((s) => s.fillStrengthEnabled);
  const effectiveVolumeEnabled = paneTogglesOverride?.volumeEnabled ?? volumeEnabled;
  const effectiveQuoteTotalsEnabled = paneTogglesOverride?.quoteTotalsEnabled ?? quoteTotalsEnabled;
  const effectiveRatioEnabled = paneTogglesOverride?.ratioEnabled ?? ratioEnabled;
  const effectiveFillStrengthEnabled = paneTogglesOverride?.fillStrengthEnabled ?? fillStrengthEnabled;

  // Single source for the pane-mount toggles, consumed by BOTH the stretch
  // effect and the render-side paneSpecsForTimeframe call. Building it once
  // removes the risk of the two call sites drifting (one updated, one not).
  const paneToggles = useMemo(
    () => ({
      foreignNet: foreignNetEnabled,
      institutionNet: institutionNetEnabled,
      volumeEnabled: effectiveVolumeEnabled,
      quoteTotalsEnabled: effectiveQuoteTotalsEnabled,
      ratioEnabled: effectiveRatioEnabled,
      fillStrengthEnabled: effectiveFillStrengthEnabled,
      forceHogaPanes,
    }),
    [
      foreignNetEnabled,
      institutionNetEnabled,
      effectiveVolumeEnabled,
      effectiveQuoteTotalsEnabled,
      effectiveRatioEnabled,
      effectiveFillStrengthEnabled,
      forceHogaPanes,
    ],
  );

  useEffect(() => {
    if (!chart || !cb) return;
    const specs = paneSpecsForTimeframe(timeframe, paneToggles);
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
  }, [chart, cb, timeframe, paneToggles]);

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
      // Cursor left the chart pane entirely (mouse-leave) → revert to LIVE.
      // Cancel any pending valid-hover write so a queued rAF can't re-set the
      // cursor after we've cleared.
      if (param.point == null) {
        if (pending !== null) { cancelAnimationFrame(pending); pending = null; }
        useLiveCursorStore.getState().clearCursor();
        return;
      }
      if (pending !== null) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        pending = null;
        const store = useLiveCursorStore.getState();
        const t = param.time;
        // No usable time (defensive) → not on a bar → LIVE.
        if (typeof t !== 'number' || axis.segments.length === 0) {
          store.clearCursor();
          return;
        }
        // ChartStage.tsx:197 pattern — param.time is virtual-axis seconds.
        // Convert to virtual-ms, then real Unix-ms via axis.toReal().
        const realMs = axis.toReal(t * 1000);
        // Right-offset whitespace past the last candle: with CrosshairMode.Normal
        // lwc does NOT report an empty time there — it extrapolates the (gap-
        // compressed) virtual axis forward, so `realMs` lands on the session tail
        // (15:20–15:30 closing-auction window), a FUTURE no-data time. Left as a
        // cursor it pinned the sidebar to a slot parquet/SSE can't serve → blank.
        // Treat "cursor past the last real candle" as not-on-a-bar → LIVE
        // (verified 2026-06-11: coordinateToTime jumps 14:53 → 15:20 across the
        // whitespace boundary while the live edge was 14:54).
        const lastMs = lastCandleMsRef.current;
        if (lastMs !== null && realMs > lastMs) {
          store.clearCursor();
          return;
        }
        store.setCursor(realMs);
      });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      if (pending !== null) cancelAnimationFrame(pending);
      useLiveCursorStore.getState().clearCursor();
    };
  }, [chart, axis, timeframe]);

  const dwDisabled = isCalendarTimeframe(timeframe) && !forceHogaPanes;

  return (
    <div
      data-testid="live-chart-root"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', background: 'var(--bg-card)' }}
      />
      {chart && cb && axis.segments.length > 0 && (
        <>
          {paneSpecsForTimeframe(timeframe, paneToggles).map((spec, i) => (
            <RangeSeriesPane
              key={spec.name}
              chart={chart}
              // hoga panes (spec.live) get the live bundle; candle/volume/investor
              // panes get the stable chartBundle so an SSE tick doesn't re-setData them.
              bundle={spec.name === 'ratio' ? (ratioBundle ?? cb) : spec.live ? (bundle ?? cb) : cb}
              axis={axis}
              paneIndex={i}
              spec={spec}
              onPrimarySeriesReady={handleSeriesReady}
              onPrimarySeriesGone={handleSeriesGone}
            />
          ))}
          <MovingAverageOverlay chart={chart} bundle={cb} axis={axis} />
          <DailyMovingAverageOverlay chart={chart} bundle={cb} axis={axis} code={code} timeframe={timeframe} todayKst={todayKst} />
          <LiveCurrentPriceLine paneSeries={paneSeries} bundle={cb} code={code} />
          {isMinuteTimeframe(timeframe) && (
            <LiveAskPeakSegments
              paneSeries={paneSeries}
              axis={axis}
              dayAskPeaks={dayAskPeaks}
              segments={cb.segments}
              candles={cb.candles}
              todayKst={todayKst}
            />
          )}
          <DrawingOverlay chart={chart} axis={axis} paneSeries={paneSeries} />
          {/* After DrawingOverlay so the legend's ✕/eye buttons paint above the
              drawing canvas; the container is pointer-transparent so the
              crosshair + drawing hover still work underneath it. */}
          {/* P1: `cb`(캔들 경로 번들)를 memo 신선화 신호로 전달. SSE 호가 틱엔 `cb`
              식별자가 안정(2026-06-09 bundle-split)이라 레전드 재렌더가 차단되고, 캔들
              갱신 때만 새 ref가 돼 latest 값을 신선화한다. ref-during-render 불필요. */}
          <PaneLegendOverlay chart={chart} timeframe={timeframe} paneSeries={paneSeries} dataEpoch={cb} />
          <CandleTooltip chart={chart} bundle={cb} axis={axis} paneSeries={paneSeries} timeframe={timeframe} />
          {/* 고저 극값 라벨 — 보이는 범위의 최고/최저봉에 극값 대비율 라벨. cb(안정)·viewport
              구독이라 SSE 틱엔 미재렌더, 팬/줌·캔들 갱신 시에만 재계산. 토글 self-gate. */}
          <HighLowAnnotationOverlay chart={chart} bundle={cb} axis={axis} paneSeries={paneSeries} timeframe={timeframe} />
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
      {/* 빈칸 중앙 노트: 캔들이 아직 없을 때. 로딩 중이거나 rate-limit 지연이면 표시.
          rate-limit이면 "고장?" 오해를 막는 명시 문구로 전환(데이터는 결국 도착). 캔들 0인데
          로딩도 경고도 아니면(정말 데이터 없음) 노트 없이 빈 차트만. */}
      {(!cb || cb.candles.length === 0) && (isPastCandlesLoading || warnSummary.hasRateLimit) && (
        <div
          data-testid="past-candles-loading-note"
          style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', color: 'var(--fg-dimmer)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {warnSummary.hasRateLimit ? 'KIS 호출 한도로 지연 중 — 잠시 후 재시도…' : '분봉 불러오는 중…'}
        </div>
      )}
      {/* bottom-left 상태 칩 스택: 부분로딩(rate-limit, 위) + 클램프(아래). 둘 다
          하단-좌측이라 한 flex 컬럼으로 묶어 겹침을 막는다(드물게 동시 발생). */}
      {(clampEngaged || (cb !== null && cb.candles.length > 0 && warnSummary.count > 0)) && (
        <div
          style={{
            position: 'absolute', bottom: 'var(--space-md)', left: 'var(--space-md)',
            display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)',
            pointerEvents: 'none',
          }}
        >
          {/* 캔들은 있는데 일부 과거구간이 rate-limit 등으로 누락 → 비차단 안내. */}
          {cb !== null && cb.candles.length > 0 && warnSummary.count > 0 && (
            <div data-testid="partial-load-chip" style={chipStyle}>
              {warnSummary.hasRateLimit ? '일부 과거구간 로딩 지연 (호출 한도)' : '일부 과거구간 로딩 실패'}
            </div>
          )}
          {clampEngaged && (
            <div data-testid="clamp-engaged-chip" style={chipStyle}>
              최대 {PAST_CANDLES_MAX_DAYS}일까지 표시됩니다
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default LiveChartRoot;
