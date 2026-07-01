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
  type LiveMAConfig,
  type LiveTimeframe,
  isMinuteTimeframe,
  isCalendarTimeframe,
} from '../state/livePage';
import { useActivePrefs, useChartPrefsStore } from '../state/chartPrefs';
import type { LiveVenueOption } from '../state/liveVenue';
import type { AskPeak, BidPeak, RangeBundle } from '../api/types';
import { PAST_CANDLES_MAX_DAYS } from './liveDateTime';
import { initialVisibleMinuteBarsFor } from './liveVenuePolicy';
import { minuteRightOffsetBars } from './minuteViewportPolicy';
import { summarizeWarnings, type LiveDataWarning } from './liveDataWarnings';
import { useViewportBackfill } from './useViewportBackfill';
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
import LiveAskPeakSegments, { buildAskPeakOverlaySegments } from './LiveAskPeakSegments';
import LiveBidPeakSegments, { buildBidPeakOverlaySegments } from './LiveBidPeakSegments';
import TradeVolumePocOverlay from './TradeVolumePocOverlay';
import AuctionWindowOverlay from '../chart/AuctionWindowOverlay';
import DrawingOverlay from '../chart/DrawingOverlay';
import DrawingPropertyPanel from '../chart/DrawingPropertyPanel';
import PaneLegendOverlay from './PaneLegendOverlay';
import CandleTooltip from './CandleTooltip';
import HighLowAnnotationOverlay from './HighLowAnnotationOverlay';
import PriceLevelDotsOverlay from './PriceLevelDotsOverlay';
import type { PaneId } from '../chart/drawing/types';
import { useDrawingHost } from '../chart/useDrawingHost';
import type { TradeVolumePoc } from './tradeVolumePoc';

const TOKEN_SPEC = {
  bgCard: ['--bg-card', '#13131C'],
  fg: ['--fg', '#E2E8F0'],
  grid: ['--grid', '#1A1A26'],
  border: ['--border', '#1F1F2A'],
  borderStrong: ['--border-strong', '#253040'],
} as const;

function chartGridOptions(
  gridColor: string,
  horizontalEnabled: boolean,
  verticalEnabled: boolean,
) {
  return {
    vertLines: { color: gridColor, visible: verticalEnabled },
    horzLines: { color: gridColor, visible: horizontalEnabled },
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function kstDateFromMs(realMs: number): string {
  const d = new Date(realMs + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function readNumericCrosshairTimeFromSeriesData(seriesData: unknown): number | null {
  if (!(seriesData instanceof Map)) return null;
  for (const value of seriesData.values()) {
    if (value && typeof value === 'object' && 'time' in value) {
      const time = (value as { time?: unknown }).time;
      if (typeof time === 'number') return time;
    }
  }
  return null;
}

function nearestCandleMs(realMs: number, candleMs: readonly number[], bucketMs: number): number {
  if (candleMs.length === 0 || bucketMs <= 0) return realMs;
  let lo = 0;
  let hi = candleMs.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candleMs[mid] < realMs) lo = mid + 1;
    else hi = mid;
  }
  const next = candleMs[lo];
  const prev = lo > 0 ? candleMs[lo - 1] : next;
  const nearest = Math.abs(prev - realMs) <= Math.abs(next - realMs) ? prev : next;
  return Math.abs(nearest - realMs) <= bucketMs / 2 ? nearest : realMs;
}

/** Empty axis used while the bundle is loading. timeFormatter / tickMarkFormatter
 * read through `axisRef.current` to convert virtual seconds back to real KST;
 * before the real axis arrives they need a working `.toReal()` to return
 * something that doesn't crash. Mirrors ChartStage's `axisRef` pattern. */
const EMPTY_AXIS: VirtualAxis = createVirtualAxis([]);
/** 안정 빈 배열 — 기본값이 매 렌더 새 []를 만들지 않게. */
const EMPTY_ASK_PEAKS: readonly AskPeak[] = [];
const EMPTY_BID_PEAKS: readonly BidPeak[] = [];
const EMPTY_CANDLE_MS: readonly number[] = [];
const HIGH_LOW_AVOID_BASELINE_STYLE = { color: '', lineWidth: 1 };
const DAILY_MIN_EFFECTIVE_BAR_SPACING = 3.5;
const CALENDAR_MIN_VIEWPORT_WIDTH_PX = 120;

function dailyLogicalRange(
  totalBars: number,
  plotWidth: number,
  latestLogicalIndex: number | null,
): { from: number; to: number } {
  const rightOffset = CHART_TIMESCALE_OPTIONS.rightOffset ?? 0;
  const latest = latestLogicalIndex ?? totalBars - 1;
  const to = latest + 1 + rightOffset;
  const maxLegibleSpan =
    plotWidth > 0
      ? Math.max(1, Math.floor(plotWidth / DAILY_MIN_EFFECTIVE_BAR_SPACING))
      : 260;
  const loadedSpan = totalBars + rightOffset;
  const span = Math.min(loadedSpan, maxLegibleSpan);
  return { from: Math.max(0, to - span), to };
}

interface Props {
  code: string | null;
  timeframe: LiveTimeframe;
  venue?: LiveVenueOption;
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
  /** Quote/ratio/fill panes read this hoga-only bundle so their first paint and
   * tick path are independent from slower full sidecar slices. */
  hogaPaneBundle?: RangeBundle | null;
  /** Optional pane-specific bundle for ratio display when the source is already display-locked. */
  ratioBundle?: RangeBundle | null;
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
  /** Backend today all-price ask peak — optional so existing tests/callers omit it safely. */
  todayAllPriceAskPeak?: AskPeak | null;
  /** LivePage의 useDayBidPeaks 결과(거래일별) — LiveBidPeakSegments에 전달. */
  dayBidPeaks?: readonly BidPeak[];
  /** Backend today all-price bid peak — optional so existing tests/callers omit it safely. */
  todayAllPriceBidPeak?: BidPeak | null;
  /** 오늘(KST YYYYMMDD) — 오늘 세그먼트만 라이브 엣지까지 연장. */
  todayKst?: string;
  /** Per-day regular-session trade-volume POC bands. */
  tradeVolumePocs?: readonly TradeVolumePoc[];
  /** Snapshot restore can carry hoga panes on calendar timeframes. /live keeps the default gate. */
  forceHogaPanes?: boolean;
  /** Snapshot restore can pin pane mounts to saved indicator state. Omitted means read /live store. */
  paneTogglesOverride?: {
    volumeEnabled?: boolean;
    quoteTotalsEnabled?: boolean;
    ratioEnabled?: boolean;
    fillStrengthEnabled?: boolean;
    programTradeEnabled?: boolean;
    hogaPanes?: boolean;
  };
  dailyMovingAverageOverride?: {
    configs: readonly LiveMAConfig[];
    masterEnabled: boolean;
    hidden: boolean;
  };
  tradeVolumePocOverride?: {
    enabled?: boolean;
    color?: string;
    opacity?: number;
  };
  /** Save flows can read the current chart viewport without coupling to chart internals. */
  onViewportCaptureReady?: (capture: () => TabViewport | null) => void;
  /** Optional hover activity signal for consumers that must ignore sticky cursor restore. */
  onCursorActiveChange?: (active: boolean) => void;
  onCandleBasisHover?: (date: string | null) => void;
  onCandleBasisClick?: (date: string | null) => void;
}

export function shouldShowTradeVolumePocOverlay(
  timeframe: LiveTimeframe,
  forceHogaPanes: boolean,
  tradeVolumePocCount: number,
): boolean {
  return isMinuteTimeframe(timeframe) || (forceHogaPanes && tradeVolumePocCount > 0);
}

/** /live's single-chart root. Mounts the timeframe-appropriate pane set
 * (see `paneSpecsForTimeframe`) inside one createChart instance so
 * timeScale is shared across candle/volume/(hoga) panes. */
export function LiveChartRoot({ code, timeframe, venue = 'KRX', viewIdentity, bundle, chartBundle, hogaPaneBundle, ratioBundle, clampEngaged, isPastCandlesLoading, isExtending = false, pastDataWarnings, restoreViewport = null, dayAskPeaks = EMPTY_ASK_PEAKS, todayAllPriceAskPeak = null, dayBidPeaks = EMPTY_BID_PEAKS, todayAllPriceBidPeak = null, todayKst = '', tradeVolumePocs = [], forceHogaPanes = false, paneTogglesOverride, dailyMovingAverageOverride, tradeVolumePocOverride, onViewportCaptureReady, onCursorActiveChange, onCandleBasisHover, onCandleBasisClick }: Props) {
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
  const paneHogaBundle = hogaPaneBundle ?? hogaBundle;
  const paneRatioBundle = ratioBundle ?? paneHogaBundle;
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
    const rawSegments = cb.segments.map((s) => ({
      date: s.date,
      sessionOpenMs: s.session_open_ms,
      sessionCloseMs: s.session_close_ms,
    }));
    return createVirtualAxis(
      rawSegments,
      rawSegments[0].sessionOpenMs,
      { mode: isCalendarTimeframe(timeframe) ? 'calendar' : 'intraday' },
    );
  }, [cb?.segments, timeframe]);

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
  const userAdjustedViewportRef = useRef(false);
  const userAdjustedViewportKeyRef = useRef<string | null>(null);
  if (userAdjustedViewportKeyRef.current !== viewKey) {
    userAdjustedViewportKeyRef.current = viewKey;
    userAdjustedViewportRef.current = restoreViewport?.userAdjusted === true;
  }
  const markViewportUserAdjusted = useCallback(() => {
    userAdjustedViewportRef.current = true;
  }, []);
  // Last real candle's real-ms, read by the crosshair handler to detect the
  // right-offset whitespace (cursor past the last bar) without making the
  // handler effect depend on every SSE bundle. Written during render (like
  // axisRef) so it's current before any child effect; null when no candles.
  const lastCandleMsRef = useRef<number | null>(null);
  lastCandleMsRef.current =
    cb && cb.candles.length > 0 ? cb.candles[cb.candles.length - 1].ts_ms : null;
  const lastStableCandleLogicalIndexRef = useRef<number | null>(null);
  const candleMs = useMemo(
    () => (cb ? cb.candles.map((candle) => candle.ts_ms) : EMPTY_CANDLE_MS),
    [cb],
  );
  const candleMsRef = useRef<readonly number[]>(EMPTY_CANDLE_MS);
  candleMsRef.current = candleMs;
  const bucketMsRef = useRef<number>(cb?.bucket_ms ?? 0);
  bucketMsRef.current = cb?.bucket_ms ?? 0;
  const publishedCursorMsRef = useRef<number | null>(null);
  const publishedBasisDateRef = useRef<string | null>(null);
  const publishedCursorActiveRef = useRef<boolean | null>(null);

  // chartRef bridges the live chart instance to the viewport-capture callback
  // (registered once, reads refs) so the tabs store can snapshot the OUTGOING
  // tab's view synchronously on switch-away, before the per-viewKey remount.
  // Written during render (like axisRef) so it's current before any effect.
  const chartRef = useRef<IChartApi | null>(chart);
  chartRef.current = chart;
  const horizontalGridLinesEnabled = useActivePrefs((prefs) => prefs.horizontalGridLinesEnabled);
  const verticalGridLinesEnabled = useActivePrefs((prefs) => prefs.verticalGridLinesEnabled);

  // Viewport capture (ADR-0069 A안): read the live chart's visible range + zoom
  // and pin them to a real-time anchor. The tabs store calls this on switch-away
  // (focusTab / openOrFocusTab) to save the outgoing tab's view. Stable identity
  // (refs only) so the registration effect runs once.
  const captureViewport = useCallback((): TabViewport | null => {
    const c = chartRef.current;
    if (!c) return null;
    try {
      const ts = c.timeScale();
      let lastCandleLogicalIndex: number | null = null;
      const lastCandleMs = lastCandleMsRef.current;
      if (lastCandleMs !== null) {
        const idx = ts.timeToIndex(realMsToVirtualSeconds(axisRef.current, lastCandleMs) as Time, true);
        if (typeof idx === 'number' && Number.isFinite(idx)) {
          lastCandleLogicalIndex = idx;
          lastStableCandleLogicalIndexRef.current = idx;
        } else {
          lastCandleLogicalIndex = lastStableCandleLogicalIndexRef.current;
        }
      }
      const vp = viewportFromRanges(
        ts.getVisibleLogicalRange(),
        ts.getVisibleRange(),
        axisRef.current,
        lastCandleMs,
        lastCandleLogicalIndex,
      );
      if (!vp) return null;
      return userAdjustedViewportRef.current ? { ...vp, userAdjusted: true } : vp;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    onViewportCaptureReady?.(captureViewport);
    return () => onViewportCaptureReady?.(() => null);
  }, [captureViewport, onViewportCaptureReady]);

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
  const canTriggerBackfill = useCallback(
    () => lastAppliedCountRef.current !== null || useLivePageStore.getState().historicalFromDate !== null,
    [],
  );
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
  const [viewportLayoutTick, setViewportLayoutTick] = useState(0);
  const revealRafRef = useRef<number | null>(null);
  const calendarViewportRetryRafRef = useRef<number | null>(null);
  const chartReady = revealedKey === viewKey;
  useEffect(() => {
    lastAppliedCountRef.current = null;
    lastStableCandleLogicalIndexRef.current = null;
    if (revealRafRef.current !== null) {
      cancelAnimationFrame(revealRafRef.current);
      revealRafRef.current = null;
    }
    if (calendarViewportRetryRafRef.current !== null) {
      cancelAnimationFrame(calendarViewportRetryRafRef.current);
      calendarViewportRetryRafRef.current = null;
    }
  }, [viewKey]);
  // Cancel a pending reveal rAF on unmount so it can't setState after teardown.
  useEffect(() => () => {
    if (revealRafRef.current !== null) cancelAnimationFrame(revealRafRef.current);
    if (calendarViewportRetryRafRef.current !== null) cancelAnimationFrame(calendarViewportRetryRafRef.current);
  }, []);

  // Leftward-pan historical backfill + staleness-free viewport repositioning
  // (pre-swap layout snapshot, post-setData reposition, lazy-fetch trigger,
  // settle-loop) live in this headless controller. Called from the parent so
  // its layout snapshot runs before — and its repositioner after —
  // RangeSeriesPane's child setData within the same bundle commit. The
  // repositioner and the initial-view effect below are mutually exclusive via
  // historicalFromDate (null → initial-view owns the viewport; non-null →
  // repositioner), so their relative declaration order is immaterial.
  useViewportBackfill({
    chart,
    axis,
    bundle: cb,
    timeframe,
    isExtending,
    code: code ?? '',
    canTriggerBackfill,
  });
  // Modifier-aware 휠 줌/팬 — handleScale.mouseWheel: false(아래 createChartEx
  // 옵션)와 한 쌍. 스펙: docs/superpowers/specs/2026-06-07-live-wheel-interactions-design.md
  const getLiveRightOffsetBars = useCallback((visibleBars: number, plotWidth: number) => (
    isMinuteTimeframe(timeframe)
      ? minuteRightOffsetBars(visibleBars, plotWidth)
      : (CHART_TIMESCALE_OPTIONS.rightOffset ?? 0)
  ), [timeframe]);
  useWheelInteractions(chart, containerRef, cb, axis, markViewportUserAdjusted, getLiveRightOffsetBars);
  useEffect(() => {
    const container = containerRef.current;
    const target = container?.parentElement ?? container;
    if (!chart || !target) return;
    const ts = chart.timeScale();
    let dragStart: { x: number; y: number } | null = null;
    let pendingUserDragRangeChange = false;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragStart = { x: event.clientX, y: event.clientY };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragStart) return;
      const dx = event.clientX - dragStart.x;
      const dy = event.clientY - dragStart.y;
      if (Math.hypot(dx, dy) >= 4) {
        pendingUserDragRangeChange = true;
        dragStart = null;
      }
    };
    const clearDrag = () => {
      dragStart = null;
      pendingUserDragRangeChange = false;
    };
    const onVisibleLogicalRangeChange = () => {
      if (!pendingUserDragRangeChange) return;
      pendingUserDragRangeChange = false;
      markViewportUserAdjusted();
    };
    target.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', clearDrag);
    window.addEventListener('pointercancel', clearDrag);
    ts.subscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);
    return () => {
      target.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', clearDrag);
      window.removeEventListener('pointercancel', clearDrag);
      ts.unsubscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);
    };
  }, [chart, containerRef, markViewportUserAdjusted]);
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
        const shouldUseTimeAnchor =
          !restoreViewport.atLiveEdge ||
          restoreViewport.userAdjusted === true;
        const anchorInRange =
          shouldUseTimeAnchor &&
          restoreViewport.rightEdgeMs >= cb.candles[0].ts_ms;
        const idx = anchorInRange
          ? tsR.timeToIndex(
              realMsToVirtualSeconds(axisRef.current, restoreViewport.rightEdgeMs) as Time,
              true,
            )
          : null;
        const restoreRightOffset = isMinuteTimeframe(timeframe)
          ? minuteRightOffsetBars(restoreViewport.barSpan, tsR.width())
          : undefined;
        const range = computeRestoreRange(restoreViewport, totalBarsR, idx, restoreRightOffset);
        if (range) {
          if (timeframe === 'D' && restoreViewport.atLiveEdge && restoreViewport.userAdjusted !== true) {
            const rightPadding =
              typeof restoreViewport.rightPaddingBars === 'number' &&
              Number.isFinite(restoreViewport.rightPaddingBars)
                ? Math.max(0, restoreViewport.rightPaddingBars)
                : (CHART_TIMESCALE_OPTIONS.rightOffset ?? 0);
            const plotWidth = Math.max(tsR.width(), containerRef.current?.clientWidth ?? 0);
            const maxLegibleSpan =
              plotWidth > 0
                ? Math.max(1, Math.floor(plotWidth / DAILY_MIN_EFFECTIVE_BAR_SPACING))
                : 260;
            const to = totalBarsR + rightPadding;
            const span = Math.min(to, Math.max(1, Math.round(restoreViewport.barSpan)), maxLegibleSpan);
            tsR.setVisibleLogicalRange({ from: Math.max(0, to - span), to });
          } else {
            tsR.setVisibleLogicalRange({ from: range.from, to: range.to });
          }
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
    if (restoreViewport && lastAppliedCountRef.current !== null && isCalendarTimeframe(timeframe)) {
      const totalBarsR = cb.candles.length;
      if (lastAppliedCountRef.current !== totalBarsR) {
        try {
          const hasSavedPadding =
            typeof restoreViewport.rightPaddingBars === 'number' &&
            Number.isFinite(restoreViewport.rightPaddingBars);
          if (restoreViewport.atLiveEdge && (restoreViewport.userAdjusted !== true || hasSavedPadding)) {
            const rightPadding = hasSavedPadding
              ? Math.max(0, restoreViewport.rightPaddingBars!)
              : (CHART_TIMESCALE_OPTIONS.rightOffset ?? 0);
            const tsR = chart.timeScale();
            const plotWidth = Math.max(tsR.width(), containerRef.current?.clientWidth ?? 0);
            const maxLegibleSpan =
              plotWidth > 0
                ? Math.max(1, Math.floor(plotWidth / DAILY_MIN_EFFECTIVE_BAR_SPACING))
                : 260;
            const to = totalBarsR + rightPadding;
            const span = Math.min(to, Math.max(1, Math.round(restoreViewport.barSpan)), maxLegibleSpan);
            tsR.setVisibleLogicalRange({ from: Math.max(0, to - span), to });
          }
          lastAppliedCountRef.current = totalBarsR;
        } catch {
          // chart torn down between effect runs
        }
      }
      reveal();
      return;
    }
    const historicalFromDate = useLivePageStore.getState().historicalFromDate;
    if (timeframe === 'D') {
      const shouldPreserveScrolledBackDaily =
        historicalFromDate !== null &&
        (lastAppliedCountRef.current !== null || restoreViewport?.atLiveEdge === false);
      if (shouldPreserveScrolledBackDaily) {
        reveal();
        return;
      }
    } else if (historicalFromDate !== null) {
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
        const lastMs = cb.candles[cb.candles.length - 1]?.ts_ms;
        let latestLogicalIndex: number | null = null;
        if (lastMs != null && typeof ts.timeToIndex === 'function') {
          const idx = ts.timeToIndex(realMsToVirtualSeconds(axisRef.current, lastMs) as Time, true);
          if (typeof idx === 'number' && Number.isFinite(idx)) latestLogicalIndex = idx;
        }
        const latest = latestLogicalIndex ?? totalBars - 1;
        const target = initialVisibleMinuteBarsFor(timeframe, venue);
        const visibleBars = Math.min(totalBars, target);
        const rightOffset = minuteRightOffsetBars(visibleBars, ts.width());
        const from = Math.max(0, latest + 1 - visibleBars);
        const to = latest + 1 + rightOffset;
        ts.setVisibleLogicalRange({ from, to });
        lastAppliedCountRef.current = totalBars;
        reveal();
      } else if (isCalendarTimeframe(timeframe)) {
        // Calendar frames avoid fitContent's multi-step internal range settle.
        // Use a width-derived span with the standard rightOffset so D/W/M all
        // open with visible candles plus the same empty area on the right.
        if (applied === totalBars) { reveal(); return; }
        const plotWidth = Math.max(ts.width(), containerRef.current?.clientWidth ?? 0);
        if (plotWidth < CALENDAR_MIN_VIEWPORT_WIDTH_PX) {
          if (calendarViewportRetryRafRef.current === null) {
            calendarViewportRetryRafRef.current = requestAnimationFrame(() => {
              calendarViewportRetryRafRef.current = null;
              setViewportLayoutTick((value) => value + 1);
            });
          }
          return;
        }
        ts.setVisibleLogicalRange(dailyLogicalRange(totalBars, plotWidth, null));
        lastAppliedCountRef.current = totalBars;
        reveal();
      }
    } catch {
      // chart torn down between effect runs
    }
  }, [chart, cb, timeframe, venue, isPastCandlesLoading, viewKey, revealedKey, restoreViewport, viewportLayoutTick]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const tokens = resolveTokens(TOKEN_SPEC);
    // Explicit generics pin HorzScaleItem=Time: without them createChartEx
    // infers `unknown` and the IHorzScaleBehavior<Time> instance no longer
    // matches. The behavior's options() override (TimeChartOptions) is what
    // makes timeScale.tickMarkFormatter typecheck below.
    const gridPrefs = useChartPrefsStore.getState();
    const c = createChartEx<Time, ReturnType<typeof createKstHorzScaleBehavior>>(
      el,
      createKstHorzScaleBehavior(axisRef),
      {
      ...CHART_LAYOUT_OPTIONS,
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { color: tokens.bgCard },
        textColor: tokens.fg,
        panes: {
          separatorColor: tokens.borderStrong,
          separatorHoverColor: tokens.fg,
        },
      },
      grid: chartGridOptions(
        tokens.grid,
        gridPrefs.horizontalGridLinesEnabled,
        gridPrefs.verticalGridLinesEnabled,
      ),
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
    // Dev-only QA handles for browser-level chart viewport inspection.
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

  useEffect(() => {
    if (!chart) return;
    const tokens = resolveTokens(TOKEN_SPEC);
    chart.applyOptions({
      grid: chartGridOptions(tokens.grid, horizontalGridLinesEnabled, verticalGridLinesEnabled),
    });
  }, [chart, horizontalGridLinesEnabled, verticalGridLinesEnabled]);

  const foreignNetEnabled = useLivePageStore((s) => s.foreignNetEnabled);
  const institutionNetEnabled = useLivePageStore((s) => s.institutionNetEnabled);
  const volumeEnabled = useLivePageStore((s) => s.volumeEnabled);
  const quoteTotalsEnabled = useLivePageStore((s) => s.quoteTotalsEnabled);
  const ratioEnabled = useLivePageStore((s) => s.ratioEnabled);
  const fillStrengthEnabled = useLivePageStore((s) => s.fillStrengthEnabled);
  const programTradeEnabled = useLivePageStore((s) => s.programTradeEnabled);
  const askPeakEnabled = useLivePageStore((s) => s.askPeakEnabled);
  const bidPeakEnabled = useLivePageStore((s) => s.bidPeakEnabled);
  const askPeakIntraMax = useActivePrefs((s) => s.askPeakIntraMax);
  const askPeakShowAllPrices = useActivePrefs((s) => s.askPeakShowAllPrices);
  const bidPeakIntraMax = useActivePrefs((s) => s.bidPeakIntraMax);
  const bidPeakShowAllPrices = useActivePrefs((s) => s.bidPeakShowAllPrices);
  const candleAlwaysOnTop = useActivePrefs((s) => s.candleAlwaysOnTop);
  const effectiveVolumeEnabled = paneTogglesOverride?.volumeEnabled ?? volumeEnabled;
  const effectiveQuoteTotalsEnabled = paneTogglesOverride?.quoteTotalsEnabled ?? quoteTotalsEnabled;
  const effectiveRatioEnabled = paneTogglesOverride?.ratioEnabled ?? ratioEnabled;
  const effectiveFillStrengthEnabled = paneTogglesOverride?.fillStrengthEnabled ?? fillStrengthEnabled;
  const effectiveProgramTradeEnabled = paneTogglesOverride?.programTradeEnabled ?? programTradeEnabled;
  const effectiveHogaPanes = paneTogglesOverride?.hogaPanes;

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
      programTradeEnabled: effectiveProgramTradeEnabled,
      hogaPanes: effectiveHogaPanes,
      forceHogaPanes,
    }),
    [
      foreignNetEnabled,
      institutionNetEnabled,
      effectiveVolumeEnabled,
      effectiveQuoteTotalsEnabled,
      effectiveRatioEnabled,
      effectiveFillStrengthEnabled,
      effectiveProgramTradeEnabled,
      effectiveHogaPanes,
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

  const highLowAvoidLabelYLines = useMemo(() => {
    if (!cb || !isMinuteTimeframe(timeframe)) return [];
    const series = paneSeries.get('candle' as PaneId);
    if (!series) return [];
    const wallSegments = [
      ...(askPeakEnabled
        ? buildAskPeakOverlaySegments({
          dayAskPeaks,
          todayAllPriceAskPeak,
          segments: cb.segments,
          candles: cb.candles,
          axis,
          todayKst,
          baselineStyle: HIGH_LOW_AVOID_BASELINE_STYLE,
          allPriceStyle: HIGH_LOW_AVOID_BASELINE_STYLE,
          intraMax: askPeakIntraMax,
          showAllPrices: askPeakShowAllPrices,
        })
        : []),
      ...(bidPeakEnabled
        ? buildBidPeakOverlaySegments({
          dayBidPeaks,
          todayAllPriceBidPeak,
          segments: cb.segments,
          candles: cb.candles,
          axis,
          todayKst,
          baselineStyle: HIGH_LOW_AVOID_BASELINE_STYLE,
          allPriceStyle: HIGH_LOW_AVOID_BASELINE_STYLE,
          intraMax: bidPeakIntraMax,
          showAllPrices: bidPeakShowAllPrices,
        })
        : []),
    ];
    const yLines: number[] = [];
    for (const segment of wallSegments) {
      const y = series.priceToCoordinate(segment.price);
      if (y === null) continue;
      const rounded = Math.round(Number(y));
      if (!yLines.includes(rounded)) yLines.push(rounded);
    }
    return yLines;
  }, [
    askPeakEnabled,
    askPeakIntraMax,
    askPeakShowAllPrices,
    axis,
    bidPeakEnabled,
    bidPeakIntraMax,
    bidPeakShowAllPrices,
    cb,
    dayAskPeaks,
    dayBidPeaks,
    paneSeries,
    timeframe,
    todayAllPriceAskPeak,
    todayAllPriceBidPeak,
    todayKst,
  ]);

  const publishCursorHover = useCallback(
    (virtualTime: unknown, pointX?: number): void => {
      if (!chart) return;
      const store = useLiveCursorStore.getState();
      const publishBasisHover = (date: string | null) => {
        if (publishedBasisDateRef.current === date) return;
        publishedBasisDateRef.current = date;
        onCandleBasisHover?.(date);
      };
      const publishCursorActive = (active: boolean) => {
        if (publishedCursorActiveRef.current === active) return;
        publishedCursorActiveRef.current = active;
        onCursorActiveChange?.(active);
      };
      const publishCursorMs = (cursorMs: number) => {
        if (publishedCursorMsRef.current === cursorMs && store.cursorMs === cursorMs) return;
        publishedCursorMsRef.current = cursorMs;
        store.setCursor(cursorMs);
      };
      const t = typeof virtualTime === 'number'
        ? virtualTime
        : (typeof pointX === 'number' ? chart.timeScale().coordinateToTime(pointX) : null);
      const lastMs = lastCandleMsRef.current;
      // No usable time while still inside the chart surface means the pointer
      // is over an internal blank band, not outside the chart. Keep sidebar
      // spot indicators on the latest concrete candle; only mouse-leave
      // returns to latest streaming mode.
      if (typeof t !== 'number' || axis.segments.length === 0) {
        if (lastMs !== null) {
          publishBasisHover(kstDateFromMs(lastMs));
          publishCursorActive(true);
          publishCursorMs(lastMs);
          return;
        }
        publishCursorActive(false);
        store.clearCursor();
        publishedCursorMsRef.current = null;
        return;
      }
      // ChartStage.tsx:197 pattern — param.time is virtual-axis seconds.
      // Convert to virtual-ms, then real Unix-ms via axis.toReal().
      let realMs = axis.toReal(t * 1000);
      // Right-offset whitespace past the last candle: keep the sidebar pinned
      // to the last concrete candle instead of a future no-data slot.
      if (lastMs !== null && realMs > lastMs) {
        realMs = lastMs;
      }
      const cursorMs = nearestCandleMs(realMs, candleMsRef.current, bucketMsRef.current);
      publishBasisHover(kstDateFromMs(cursorMs));
      publishCursorActive(true);
      publishCursorMs(cursorMs);
    },
    [axis, chart, onCandleBasisHover, onCursorActiveChange],
  );

  const drawingHoverRafRef = useRef<number | null>(null);
  const drawingHoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const handleDrawingOverlayHover = useCallback(
    (point: { x: number; y: number }) => {
      if (!chart) return;
      drawingHoverPointRef.current = point;
      if (drawingHoverRafRef.current !== null) return;
      drawingHoverRafRef.current = requestAnimationFrame(() => {
        drawingHoverRafRef.current = null;
        const latest = drawingHoverPointRef.current;
        drawingHoverPointRef.current = null;
        if (!latest) return;
        publishCursorHover(chart.timeScale().coordinateToTime(latest.x), latest.x);
      });
    },
    [chart, publishCursorHover],
  );

  useEffect(() => () => {
    if (drawingHoverRafRef.current !== null) {
      cancelAnimationFrame(drawingHoverRafRef.current);
      drawingHoverRafRef.current = null;
    }
  }, []);

  // ADR-0044: hover → cursor store. Only mount on minute timeframes —
  // calendar timeframes (D/W/M) don't have backing parquet on /live.
  // rAF-coalesce to one update per frame (matches ChartStage's pattern).
  useEffect(() => {
    // Publish cursor on ALL timeframes (Pane Legend reads it on D too). Spot-mode
    // entry stays minute-only — gated on the LiveSidebar consumer side (ADR-0044).
    if (!chart) {
      // Session transition safety: when chart instance disappears (view/key
      // change or page unmount), clear sticky state too.
      if (publishedCursorActiveRef.current !== false) {
        publishedCursorActiveRef.current = false;
        onCursorActiveChange?.(false);
      }
      publishedBasisDateRef.current = null;
      publishedCursorMsRef.current = null;
      useLiveCursorStore.getState().resetCursor();
      return;
    }
    let pending: number | null = null;
    const handler = (param: {
      time?: unknown;
      point?: { x: number } | null;
      seriesData?: unknown;
    }) => {
      // Cursor left the chart pane entirely (mouse-leave) → return the sidebar
      // to latest mode. Cancel any pending valid-hover write so a queued rAF
      // can't re-set the cursor after the pointer is already off-chart.
      if (param.point == null) {
        if (pending !== null) { cancelAnimationFrame(pending); pending = null; }
        if (publishedCursorActiveRef.current !== false) {
          publishedCursorActiveRef.current = false;
          onCursorActiveChange?.(false);
        }
        if (publishedBasisDateRef.current !== null) {
          publishedBasisDateRef.current = null;
          onCandleBasisHover?.(null);
        }
        publishedCursorMsRef.current = null;
        useLiveCursorStore.getState().clearCursor();
        return;
      }
      if (pending !== null) cancelAnimationFrame(pending);
      const point = param.point;
      pending = requestAnimationFrame(() => {
        pending = null;
        const t = typeof param.time === 'number'
          ? param.time
          : (readNumericCrosshairTimeFromSeriesData(param.seriesData)
            ?? chart.timeScale().coordinateToTime(point.x));
        publishCursorHover(t, point.x);
      });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      if (pending !== null) cancelAnimationFrame(pending);
      publishedBasisDateRef.current = null;
      onCandleBasisHover?.(null);
      // Preserve user context only while the chart instance is active; on teardown
      // (view key / timeframe navigation) reset both cursor states.
      if (publishedCursorActiveRef.current !== false) {
        publishedCursorActiveRef.current = false;
        onCursorActiveChange?.(false);
      }
      publishedCursorMsRef.current = null;
      useLiveCursorStore.getState().resetCursor();
    };
  }, [chart, axis, timeframe, onCursorActiveChange, onCandleBasisHover, publishCursorHover]);

  useEffect(() => {
    if (!chart || !onCandleBasisClick) return;
    const handler = (param: { time?: unknown; point?: { x: number } | null }) => {
      if (param.point == null || typeof param.time !== 'number' || axis.segments.length === 0) {
        onCandleBasisClick(null);
        return;
      }
      const realMs = axis.toReal(param.time * 1000);
      const lastMs = lastCandleMsRef.current;
      if (lastMs !== null && realMs > lastMs) {
        onCandleBasisClick(null);
        return;
      }
      onCandleBasisClick(kstDateFromMs(realMs));
    };
    chart.subscribeClick(handler);
    return () => {
      chart.unsubscribeClick(handler);
    };
  }, [chart, axis, onCandleBasisClick]);

  const dwDisabled = isCalendarTimeframe(timeframe) && !forceHogaPanes;
  const showTradeVolumePocOverlay = shouldShowTradeVolumePocOverlay(
    timeframe,
    forceHogaPanes,
    tradeVolumePocs.length,
  );

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
          {candleAlwaysOnTop && (
            <>
              <MovingAverageOverlay chart={chart} bundle={cb} axis={axis} />
              <DailyMovingAverageOverlay chart={chart} bundle={cb} axis={axis} code={code} timeframe={timeframe} venue={venue} todayKst={todayKst} override={dailyMovingAverageOverride} />
            </>
          )}
          {paneSpecsForTimeframe(timeframe, paneToggles).map((spec, i) => (
            <RangeSeriesPane
              key={spec.name}
              chart={chart}
              // hoga panes (spec.live) get the live bundle; candle/volume/investor
              // panes get the stable chartBundle so an SSE tick doesn't re-setData them.
              bundle={
                spec.name === 'ratio'
                  ? (paneRatioBundle ?? cb)
                  : (spec.name === 'quote-totals' || spec.name === 'fill-strength')
                    ? (paneHogaBundle ?? cb)
                    : spec.live
                      ? (bundle ?? cb)
                      : cb
              }
              axis={axis}
              paneIndex={i}
              spec={spec}
              forceSetData={isCalendarTimeframe(timeframe) && spec.name === 'candle'}
              candleAlwaysOnTop={candleAlwaysOnTop}
              onPrimarySeriesReady={handleSeriesReady}
              onPrimarySeriesGone={handleSeriesGone}
            />
          ))}
          {!candleAlwaysOnTop && (
            <>
              <MovingAverageOverlay chart={chart} bundle={cb} axis={axis} />
              <DailyMovingAverageOverlay chart={chart} bundle={cb} axis={axis} code={code} timeframe={timeframe} venue={venue} todayKst={todayKst} override={dailyMovingAverageOverride} />
            </>
          )}
          <LiveCurrentPriceLine paneSeries={paneSeries} bundle={cb} code={code} />
          {isMinuteTimeframe(timeframe) && (
            <LiveAskPeakSegments
              paneSeries={paneSeries}
              axis={axis}
              dayAskPeaks={dayAskPeaks}
              todayAllPriceAskPeak={todayAllPriceAskPeak}
              segments={cb.segments}
              candles={cb.candles}
              todayKst={todayKst}
            />
          )}
          {isMinuteTimeframe(timeframe) && (
            <LiveBidPeakSegments
              paneSeries={paneSeries}
              axis={axis}
              dayBidPeaks={dayBidPeaks}
              todayAllPriceBidPeak={todayAllPriceBidPeak}
              segments={cb.segments}
              candles={cb.candles}
              todayKst={todayKst}
            />
          )}
          {showTradeVolumePocOverlay && (
            <TradeVolumePocOverlay
              paneSeries={paneSeries}
              axis={axis}
              pocs={tradeVolumePocs}
              segments={cb.segments}
              candles={cb.candles}
              todayKst={todayKst}
              override={tradeVolumePocOverride}
              behindSeries={candleAlwaysOnTop}
            />
          )}
          <DrawingOverlay
            chart={chart}
            axis={axis}
            paneSeries={paneSeries}
            onChartHoverPassthrough={handleDrawingOverlayHover}
          />
          {/* After DrawingOverlay so the legend's ✕/eye buttons paint above the
              drawing canvas; the container is pointer-transparent so the
              crosshair + drawing hover still work underneath it. */}
          {/* P1: `cb`(캔들 경로 번들)를 memo 신선화 신호로 전달. SSE 호가 틱엔 `cb`
              식별자가 안정(2026-06-09 bundle-split)이라 레전드 재렌더가 차단되고, 캔들
              갱신 때만 새 ref가 돼 latest 값을 신선화한다. ref-during-render 불필요. */}
          <PaneLegendOverlay chart={chart} timeframe={timeframe} paneSeries={paneSeries} dataEpoch={cb} />
          <CandleTooltip chart={chart} bundle={cb} quoteBundle={paneRatioBundle} axis={axis} paneSeries={paneSeries} timeframe={timeframe} />
          {/* 고저 극값 라벨 — 보이는 범위의 최고/최저봉에 극값 대비율 라벨. cb(안정)·viewport
              구독이라 SSE 틱엔 미재렌더, 팬/줌·캔들 갱신 시에만 재계산. 토글 self-gate. */}
          <HighLowAnnotationOverlay
            chart={chart}
            bundle={cb}
            axis={axis}
            paneSeries={paneSeries}
            timeframe={timeframe}
            avoidLabelYLines={highLowAvoidLabelYLines}
          />
          {isMinuteTimeframe(timeframe) && hogaBundle && (
            <PriceLevelDotsOverlay chart={chart} bundle={hogaBundle} axis={axis} paneSeries={paneSeries} />
          )}
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
