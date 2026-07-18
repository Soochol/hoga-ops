import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  createChartEx,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { createKstHorzScaleBehavior } from '../util/kstHorzScaleBehavior';
import { resolveTokensThemed, currentThemeKey } from '../util/tokens';
import {
  CHART_CROSSHAIR_OPTIONS,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';
import { createVirtualAxis, type VirtualAxis } from '../util/virtualAxis';
import RangeSeriesPane, { type SeriesLegendMeta } from '../chart/RangeSeriesPane';
import { usePaneLegendRegistry } from './indicators/paneLegendRegistry';
import { paneSpecsForTimeframe } from './paneSpecsForTimeframe';
import { resolvePaneToggles } from './indicators/indicatorPaneProfiles';
import DayBoundaryOverlay from '../chart/DayBoundaryOverlay';
import {
  useLivePageStore,
  type LiveMAConfig,
  type LiveTimeframe,
  isMinuteTimeframe,
  isCalendarTimeframe,
} from '../state/livePage';
import { useActivePrefs, useChartPrefsStore, type ChartViewPrefs } from '../state/chartPrefs';
import type { LiveVenueOption } from '../state/liveVenue';
import type { LiveTodayAskPeak, LiveTodayBidPeak } from '../api/liveSeries';
import { TIMEFRAME_TO_MS, type AskPeak, type BidPeak, type RangeBundle, type DepthHeatmapPointWire } from '../api/types';
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
import {
  alignSidebarCursorMs,
  shouldPublishSidebarCursor,
  sidebarCursorPublishDelayMs,
} from './sidebarCursorRateLimit';
import { useLiveAxisStore } from './useLiveAxisStore';
import MovingAverageOverlay from './indicators/MovingAverageOverlay';
import DailyMovingAverageOverlay from './indicators/DailyMovingAverageOverlay';
import LiveCurrentPriceLine from './LiveCurrentPriceLine';
import QuoteLevelLines from './QuoteLevelLines';
import { freshLiveTradePrice } from './deriveCurrentPriceLine';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import LiveAskPeakSegments, { buildAskPeakOverlaySegments } from './LiveAskPeakSegments';
import LiveBidPeakSegments, { buildBidPeakOverlaySegments } from './LiveBidPeakSegments';
import {
  deriveDayAskPeaksIncrementalAsOf,
  deriveTodayAllPriceAskPeakIncrementalAsOf,
} from './useDayAskPeaks';
import {
  deriveDayBidPeaksIncrementalAsOf,
  deriveTodayAllPriceBidPeakIncrementalAsOf,
} from './useDayBidPeaks';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';
import LivePeakWallDockedLabels from './LivePeakWallDockedLabels';
import {
  rightmostVisibleCandleCutoff,
  type VisibleTimeCutoff,
} from './peakWallVisibleCutoff';
import TradeVolumePocOverlay from './TradeVolumePocOverlay';
import DepthHeatmapOverlay from './DepthHeatmapOverlay';
import { depthHeatmapFromWire } from './depthHeatmapWire';
import AuctionWindowOverlay from '../chart/AuctionWindowOverlay';
import DrawingOverlay from '../chart/DrawingOverlay';
import DrawingPropertyPanel from '../chart/DrawingPropertyPanel';
import PaneLegendOverlay from './PaneLegendOverlay';
import CandleTooltip from './CandleTooltip';
import HighLowAnnotationOverlay from './HighLowAnnotationOverlay';
import PriceLevelDotsOverlay from './PriceLevelDotsOverlay';
import type { CandlePaneContext } from '../chart/projectors/candle';
import type { PaneId } from '../chart/drawing/types';
import type { PaneStretchMap } from '../chart/paneOrder';
import type { BoundPaneSpec } from '../chart/paneSpecs';
import { useDrawingHost } from '../chart/useDrawingHost';
import type { TradeVolumePoc } from './tradeVolumePoc';

const TOKEN_SPEC = {
  bgCard: ['--bg-card', '#121216'],
  fg: ['--fg', '#ECECF1'],
  grid: ['--grid', '#1B1B21'],
  border: ['--border', '#232329'],
  borderStrong: ['--border-strong', '#33333C'],
  paneDivider: ['--chart-pane-divider', '#3a3a42'],
  // DESIGN.md §Tint: primary hover 는 accent 를 추적하는 --tint-selection 을
  // 읽는다(테마별로 값이 다르므로 rgba 하드코딩 금지). lwc separator hover 는
  // JS 문자열이라 CSS var 를 직접 못 받지만, resolveTokens 가 getComputedStyle
  // 로 완성된 rgba 문자열을 준다(#703).
  tintSelection: ['--tint-selection', 'rgba(240, 180, 41, 0.10)'],
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

function optionalRankLimit(
  prefs: ChartViewPrefs,
  key: 'askPeakUntradedRankLimit' | 'bidPeakUntradedRankLimit',
): 1 | 2 | 3 {
  const value = (prefs as ChartViewPrefs & Partial<Record<typeof key, number>>)[key];
  return value === 2 || value === 3 ? value : 1;
}

/** Empty axis used while the bundle is loading. timeFormatter / tickMarkFormatter
 * read through `axisRef.current` to convert virtual seconds back to real KST;
 * before the real axis arrives they need a working `.toReal()` to return
 * something that doesn't crash. Mirrors ChartStage's `axisRef` pattern. */
const EMPTY_AXIS: VirtualAxis = createVirtualAxis([]);
/** 안정 빈 배열 — 기본값이 매 렌더 새 []를 만들지 않게. */
const EMPTY_ASK_PEAKS: readonly AskPeak[] = [];
const EMPTY_BID_PEAKS: readonly BidPeak[] = [];
const EMPTY_OB_SNAPSHOTS: ReadonlyArray<ObSnapshot> = [];
const EMPTY_TRADE_SNAPSHOTS: ReadonlyArray<TradeSnapshot> = [];
const EMPTY_CANDLE_MS: readonly number[] = [];
const CURSOR_LEAVE_CLEAR_DELAY_MS = 120;
/** Leading+trailing throttle window for sidebarCursorMs publishes. The first
 * hover after a quiet window publishes immediately; while the pointer keeps
 * moving, the latest aligned cursor is published once per window — a trailing
 * debounce here starved the sidebar for the entire duration of a continuous
 * sweep (it only fired after the pointer stopped). */
const LIVE_SIDEBAR_CURSOR_THROTTLE_MS = 120;
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
  /** useLiveBundle.isHogaLoading — 호가 지표 경로 초기 fetch pending. reveal 커버가
   *  isPastCandlesLoading과 함께 써서 캔들+호가 pane을 한 번의 reveal로 등장시킨다.
   *  옵셔널 + 기본 false라 StudyPage·스냅샷 복원·기존 테스트는 무변경으로 settled. */
  isHogaLoading?: boolean;
  /** 캔들·호가 외의 오버레이 데이터(mode=sidecar 최대벽·POC·거래량분포·프로그램매매 +
   *  일봉MA)가 초기 fetch pending인지. LivePage가 isSidecarLoading || isDailyMaLoading으로
   *  OR해 전달한다. reveal 커버가 캔들·호가와 함께 써서 이 지표들이 캔들과 한 번의 reveal로
   *  등장하게 한다(장면1 — 캡 없음, 무제한 홀드). settle(성공·에러) 시 반드시 해제되므로
   *  커버가 고착되지 않는다. 옵셔널+기본 false라 StudyPage·index·기존 테스트는 무변경. */
  isSidecarLoading?: boolean;
  /** useLiveBundle.isExtending. false-edge = 한 스텝 settle → 진행 루프 다음 스텝 판정. */
  isExtending?: boolean;
  /** Coverage-gap 백필(A안): 활성 range 지표가 도달한 가장 최근 from_date. 캔들이 병합
   * 캐시로 더 과거까지 복원돼도 지표가 이 날짜까지만 있으면 useViewportBackfill이 range
   * 창을 확장한다. 옵셔널+기본 null이라 StudyPage·기존 테스트는 무변경. */
  indicatorCoverageFromDate?: string | null;
  /** 지금 range가 요청 중인 창의 from — coverage 스텝 base의 null-fallback. */
  rangeWindowFromDate?: string | null;
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
  /** Raw backend today ask-peak payload, used only for cutoff-aware live recomputation. */
  todayAskPeakInput?: LiveTodayAskPeak | null;
  /** LivePage의 useDayBidPeaks 결과(거래일별) — LiveBidPeakSegments에 전달. */
  dayBidPeaks?: readonly BidPeak[];
  /** Backend today all-price bid peak — optional so existing tests/callers omit it safely. */
  todayAllPriceBidPeak?: BidPeak | null;
  /** Raw backend today bid-peak payload, used only for cutoff-aware live recomputation. */
  todayBidPeakInput?: LiveTodayBidPeak | null;
  /** Raw live snapshots, used only for cutoff-aware today/live peak recomputation. */
  liveObSnapshots?: ReadonlyArray<ObSnapshot>;
  liveTradeSnapshots?: ReadonlyArray<TradeSnapshot>;
  /** 오늘(KST YYYYMMDD) — 오늘 세그먼트만 라이브 엣지까지 연장. */
  todayKst?: string;
  /** Per-day regular-session trade-volume POC bands. */
  tradeVolumePocs?: readonly TradeVolumePoc[];
  /** 분봉 호가 잔량 히트맵 원본 wire — LiveChartRoot 내부에서 변환. */
  depthHeatmap?: readonly DepthHeatmapPointWire[];
  /** Snapshot restore can carry hoga panes on calendar timeframes. /live keeps the default gate. */
  forceHogaPanes?: boolean;
  /** 일봉 MA 오버레이의 KIS 일봉 fetch 허용 여부(기본 true). /study는 false로 넘겨
   * 디스크(스크리너) 일봉만 쓴다 — study의 KIS 무호출 계약 유지. */
  dailyCandleKisEnabled?: boolean;
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

export function shouldShowDepthHeatmapOverlay(
  timeframe: LiveTimeframe,
  enabled: boolean,
  pointCount: number,
): boolean {
  return isMinuteTimeframe(timeframe) && enabled && pointCount > 0;
}

/** /live's single-chart root. Mounts the timeframe-appropriate pane set
 * (see `paneSpecsForTimeframe`) inside one createChart instance so
 * timeScale is shared across candle/volume/(hoga) panes. */
export function LiveChartRoot({
  code,
  timeframe,
  venue = 'KRX',
  viewIdentity,
  bundle,
  chartBundle,
  hogaPaneBundle,
  ratioBundle,
  clampEngaged,
  isPastCandlesLoading,
  isHogaLoading = false,
  isSidecarLoading = false,
  isExtending = false,
  indicatorCoverageFromDate = null,
  rangeWindowFromDate = null,
  pastDataWarnings,
  restoreViewport = null,
  dayAskPeaks = EMPTY_ASK_PEAKS,
  todayAllPriceAskPeak = null,
  todayAskPeakInput = null,
  dayBidPeaks = EMPTY_BID_PEAKS,
  todayAllPriceBidPeak = null,
  todayBidPeakInput = null,
  liveObSnapshots = EMPTY_OB_SNAPSHOTS,
  liveTradeSnapshots = EMPTY_TRADE_SNAPSHOTS,
  todayKst = '',
  tradeVolumePocs = [],
  depthHeatmap = [],
  forceHogaPanes = false,
  dailyCandleKisEnabled = true,
  paneTogglesOverride,
  dailyMovingAverageOverride,
  tradeVolumePocOverride,
  onViewportCaptureReady,
  onCursorActiveChange,
  onCandleBasisHover,
  onCandleBasisClick,
}: Props) {
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
  // Load identity for the per-view chart remount and the reveal cover. The
  // theme segment forces a full chart rebuild if the theme ever changes while
  // this stays mounted — module-resolved series colors and axis-lifetime
  // projection caches are otherwise frozen at their first resolution. In the
  // shipped UX a theme swap already coincides with an unmount (route change /
  // settings modal), so this is a forward-safety net, not the primary path.
  const themeSeg = currentThemeKey();
  const viewKey = viewIdentity
    ? `${code ?? ''}|${timeframe}|${viewIdentity}|${themeSeg}`
    : `${code ?? ''}|${timeframe}|${themeSeg}`;
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
  const { paneSeries, registerPaneSeries, unregisterPaneSeries } =
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
  // Pane Legend registry: RangeSeriesPane fires these after series creation with
  // the legend-bearing series + their meta. Kept as stable callbacks (module
  // registry setters are referentially stable) so RangeSeriesPane's memo holds.
  const registerPaneLegend = usePaneLegendRegistry((s) => s.register);
  const unregisterPaneLegend = usePaneLegendRegistry((s) => s.unregister);
  const handleLegendReady = useCallback(
    (name: string, entries: { series: ISeriesApi<any>; meta: SeriesLegendMeta }[]) =>
      registerPaneLegend(name as PaneId, entries),
    [registerPaneLegend],
  );
  const handleLegendGone = useCallback(
    (name: string) => unregisterPaneLegend(name as PaneId),
    [unregisterPaneLegend],
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
  const rememberLatestCandleLogicalIndex = (idx: number | null) => {
    if (typeof idx === 'number' && Number.isFinite(idx)) {
      lastStableCandleLogicalIndexRef.current = idx;
    }
  };
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
  const sidebarCursorTimeoutRef = useRef<number | null>(null);
  const pendingSidebarCursorMsRef = useRef<number | null>(null);
  // Wall-clock time of the last ACTUAL sidebarCursorMs store write. Same-value
  // publishes are skipped and intentionally do NOT refresh this, so wiggling
  // inside one candle bucket can't postpone the next real update.
  const sidebarCursorLastPublishAtRef = useRef<number | null>(null);

  const cancelPendingSidebarCursor = useCallback(() => {
    if (sidebarCursorTimeoutRef.current !== null) {
      window.clearTimeout(sidebarCursorTimeoutRef.current);
      sidebarCursorTimeoutRef.current = null;
    }
    pendingSidebarCursorMsRef.current = null;
  }, []);

  const clearSidebarCursor = useCallback(() => {
    cancelPendingSidebarCursor();
    useLiveCursorStore.getState().clearSidebarCursor();
  }, [cancelPendingSidebarCursor]);

  const scheduleSidebarCursor = useCallback((cursorMs: number) => {
    const aligned = alignSidebarCursorMs(cursorMs, bucketMsRef.current);
    if (sidebarCursorTimeoutRef.current !== null) {
      // Trailing timer already armed — refresh the pending value only. NOT
      // resetting the timer is what distinguishes this throttle from the old
      // debounce: continuous movement can no longer postpone the publish.
      pendingSidebarCursorMsRef.current = aligned;
      return;
    }
    const publish = (next: number) => {
      const current = useLiveCursorStore.getState().sidebarCursorMs;
      if (shouldPublishSidebarCursor(current, next)) {
        sidebarCursorLastPublishAtRef.current = performance.now();
        useLiveCursorStore.getState().setSidebarCursor(next);
      }
    };
    const delay = sidebarCursorPublishDelayMs(
      performance.now(),
      sidebarCursorLastPublishAtRef.current,
      LIVE_SIDEBAR_CURSOR_THROTTLE_MS,
    );
    if (delay === 0) {
      publish(aligned);
      return;
    }
    pendingSidebarCursorMsRef.current = aligned;
    sidebarCursorTimeoutRef.current = window.setTimeout(() => {
      sidebarCursorTimeoutRef.current = null;
      const next = pendingSidebarCursorMsRef.current;
      pendingSidebarCursorMsRef.current = null;
      if (next === null) return;
      publish(next);
    }, delay);
  }, []);

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
    indicatorCoverageFromDate,
    rangeWindowFromDate,
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
    // 데이터 홀드: 캔들 경로가 먼저 settle될 수 있으므로, 호가 경로도 settle될 때까지
    // reveal을 홀드해 모든 pane이 한 번의 reveal로 등장하게 한다. 뷰포트 적용은 커버
    // 뒤에서 그대로 선행하고, 호가 settle 시 effect가 재실행돼(isHogaLoading dep) reveal.
    // 팬 경로(historicalFromDate)는 일부러 이 게이트를 우회한다(raw reveal 유지).
    const revealWhenSettled = () => {
      // 캔들·호가·사이드카가 모두 settle될 때까지 홀드 → 캔들·모든 pane 지표가 한 번의
      // reveal로 함께 등장(장면1). 캡 없음: 어떤 지표도 늦는다고 캔들만 먼저 공개하지
      // 않는다("기다림 > 따로 뜸"). isSidecarLoading 의 모든 항은 settle(성공·에러)로
      // 반드시 false 수렴하므로 커버가 고착되지 않는다(useLiveBundle isSidecarLoading 주석).
      if (!isHogaLoading && !isSidecarLoading) reveal();
    };
    if (!chart || !cb) {
      // No chart/bundle to position yet. If the past-candle fetch has SETTLED
      // with no bundle to show (no active code / null bundle), reveal anyway so
      // the cover can't wedge opaque over a chartless surface; while still
      // loading, keep it up. Safe against a re-flash: a null bundle means no
      // candle data is pending, so nothing can later paint at the wrong zoom.
      if (chart && !isPastCandlesLoading && !isHogaLoading) reveal();
      return;
    }
    if (cb.candles.length === 0) {
      // No candles yet. If both the past-candle AND hoga fetches have settled
      // (empty result, or D/W/M with no history), reveal the empty chart so the
      // cover doesn't linger; while either is still loading, keep the cover up.
      // 신규상장 등 진짜 데이터 없는 코드도 호가가 빈/에러로 settle되므로 게이트가 열린다.
      if (!isPastCandlesLoading && !isHogaLoading) reveal();
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
        const latestCandleMs = cb.candles[totalBarsR - 1]?.ts_ms ?? null;
        const latestCandleIdx = latestCandleMs !== null
          ? tsR.timeToIndex(realMsToVirtualSeconds(axisRef.current, latestCandleMs) as Time, true)
          : null;
        const latestCandleLogicalIndex =
          typeof latestCandleIdx === 'number' && Number.isFinite(latestCandleIdx)
            ? latestCandleIdx
            : null;
        rememberLatestCandleLogicalIndex(latestCandleLogicalIndex);
        const restoreRightOffset = isMinuteTimeframe(timeframe)
          ? minuteRightOffsetBars(restoreViewport.barSpan, tsR.width())
          : undefined;
        const range = computeRestoreRange(
          restoreViewport,
          totalBarsR,
          idx,
          restoreRightOffset,
          latestCandleLogicalIndex,
        );
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
            const latestCandleRightEdge = (latestCandleLogicalIndex ?? (totalBarsR - 1)) + 1;
            const to = latestCandleRightEdge + rightPadding;
            const span = Math.min(to, Math.max(1, Math.round(restoreViewport.barSpan)), maxLegibleSpan);
            tsR.setVisibleLogicalRange({ from: Math.max(0, to - span), to });
          } else {
            tsR.setVisibleLogicalRange({ from: range.from, to: range.to });
          }
          if (range.scrollToRight) tsR.scrollToPosition(0, false);
          lastAppliedCountRef.current = totalBarsR;
          revealWhenSettled();
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
            const latestCandleMs = cb.candles[totalBarsR - 1]?.ts_ms ?? null;
            const latestCandleIdx = latestCandleMs !== null
              ? tsR.timeToIndex(realMsToVirtualSeconds(axisRef.current, latestCandleMs) as Time, true)
              : null;
            const latestCandleLogicalIndex =
              typeof latestCandleIdx === 'number' && Number.isFinite(latestCandleIdx)
                ? latestCandleIdx
                : null;
            rememberLatestCandleLogicalIndex(latestCandleLogicalIndex);
            const plotWidth = Math.max(tsR.width(), containerRef.current?.clientWidth ?? 0);
            const maxLegibleSpan =
              plotWidth > 0
                ? Math.max(1, Math.floor(plotWidth / DAILY_MIN_EFFECTIVE_BAR_SPACING))
                : 260;
            const latestCandleRightEdge = (latestCandleLogicalIndex ?? (totalBarsR - 1)) + 1;
            const to = latestCandleRightEdge + rightPadding;
            const span = Math.min(to, Math.max(1, Math.round(restoreViewport.barSpan)), maxLegibleSpan);
            tsR.setVisibleLogicalRange({ from: Math.max(0, to - span), to });
          }
          lastAppliedCountRef.current = totalBarsR;
        } catch {
          // chart torn down between effect runs
        }
      }
      revealWhenSettled();
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
      // after a pan — or after the minute branch's one-shot coverage restore —
      // both of which run when the chart is already placed and revealed.
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
        if (applied !== null) { revealWhenSettled(); return; }
        const lastMs = cb.candles[cb.candles.length - 1]?.ts_ms;
        let latestLogicalIndex: number | null = null;
        if (lastMs != null && typeof ts.timeToIndex === 'function') {
          const idx = ts.timeToIndex(realMsToVirtualSeconds(axisRef.current, lastMs) as Time, true);
          if (typeof idx === 'number' && Number.isFinite(idx)) latestLogicalIndex = idx;
        }
        rememberLatestCandleLogicalIndex(latestLogicalIndex);
        const latest = latestLogicalIndex ?? totalBars - 1;
        const target = initialVisibleMinuteBarsFor(timeframe, venue);
        const visibleBars = Math.min(totalBars, target);
        const rightOffset = minuteRightOffsetBars(visibleBars, ts.width());
        const from = Math.max(0, latest + 1 - visibleBars);
        const to = latest + 1 + rightOffset;
        ts.setVisibleLogicalRange({ from, to });
        lastAppliedCountRef.current = totalBars;
        revealWhenSettled();
        // 분봉 복귀 커버리지 복원(1-샷): 직전 분봉 뷰에서 팬으로 넓힌 창
        // (lastMinuteHistoricalFromDate)을 초기 뷰 배치 "직후"에 일반 좌측-팬
        // 확장과 같은 경로로 다시 연다 — 캔들은 병합 캐시로 즉시, range 지표는
        // 델타·청크 워크백으로 따라온다. 전환 시점에 복원하지 않는 이유: 이
        // effect 위의 historicalFromDate 게이트(reveal-only 분기)와 번들
        // atomize 게이트가 "fresh 로드 = null"에 기대므로, 배치가 끝난 뒤에야
        // 안전하게 창을 넓힐 수 있다. 확장 자체는 뷰포트를 움직이지 않는다
        // (useViewportBackfill 리포지셔너가 현재 봉을 핀).
        // activeCode 엄격 동등: /live는 activeCode truthy일 때만 이 차트를
        // 마운트하므로 항상 일치한다. 느슨한 truthy-게이트였다면 StudyPage 등
        // 다른 마운트의 분봉 배치가 live store를 extend하는 월경이 가능하다.
        const pageState = useLivePageStore.getState();
        if (
          pageState.lastMinuteHistoricalFromDate !== null &&
          pageState.candleTimeframe === timeframe &&
          pageState.activeCode === code
        ) {
          pageState.extendHistoricalRange(pageState.lastMinuteHistoricalFromDate);
        }
      } else if (isCalendarTimeframe(timeframe)) {
        // Calendar frames avoid fitContent's multi-step internal range settle.
        // Use a width-derived span with the standard rightOffset so D/W/M all
        // open with visible candles plus the same empty area on the right.
        if (applied === totalBars) { revealWhenSettled(); return; }
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
        revealWhenSettled();
      }
    } catch {
      // chart torn down between effect runs
    }
  }, [chart, cb, timeframe, venue, isPastCandlesLoading, isHogaLoading, isSidecarLoading, viewKey, revealedKey, restoreViewport, viewportLayoutTick]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const tokens = resolveTokensThemed(TOKEN_SPEC);
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
          separatorColor: tokens.paneDivider,
          // 호버는 워크스페이스 스플리터와 동일한 accent 어포던스 — DESIGN.md 의
          // 승인된 --tint-selection(primary hover, accent 추적·테마별 값)이라
          // 9px 핸들이 "굵은 선"이 아니라 은은한 하이라이트로 읽힌다(#703).
          separatorHoverColor: tokens.tintSelection,
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
    const tokens = resolveTokensThemed(TOKEN_SPEC);
    chart.applyOptions({
      grid: chartGridOptions(tokens.grid, horizontalGridLinesEnabled, verticalGridLinesEnabled),
    });
  }, [chart, horizontalGridLinesEnabled, verticalGridLinesEnabled]);

  const indicatorPrefs = useLivePageStore(
    useShallow((s) => ({
      movingAverages: s.movingAverages,
      movingAverageEnabled: s.movingAverageEnabled,
      movingAverageHidden: s.movingAverageHidden,
      volumeEnabled: s.volumeEnabled,
      quoteTotalsEnabled: s.quoteTotalsEnabled,
      ratioEnabled: s.ratioEnabled,
      fillStrengthEnabled: s.fillStrengthEnabled,
      programTradeEnabled: s.programTradeEnabled,
      foreignNetEnabled: s.foreignNetEnabled,
      institutionNetEnabled: s.institutionNetEnabled,
    })),
  );
  // 사용자 소유 pane 순서(ADR-0114 §3) — paneSpecsForTimeframe 의 3번째 인자로 전달.
  const paneOrder = useLivePageStore((s) => s.paneOrder);
  // 사용자 소유 Pane 크기 가중치(#703) — separator 드래그 결과의 SSOT.
  const paneStretch = useLivePageStore((s) => s.paneStretch);
  const setPaneStretch = useLivePageStore((s) => s.setPaneStretch);
  // separator 드래그 진행 중 여부 — stretch 재적용 effect 의 가드.
  const paneDragRef = useRef(false);
  // 드래그 종료 시 pane index → PaneId 매핑에 쓰는 최신 spec 목록.
  const paneSpecsRef = useRef<readonly BoundPaneSpec[]>([]);
  const askPeakEnabled = useLivePageStore((s) => s.askPeakEnabled);
  const bidPeakEnabled = useLivePageStore((s) => s.bidPeakEnabled);
  const askPeakWallHidden = useLivePageStore((s) => s.askPeakHidden);
  const bidPeakWallHidden = useLivePageStore((s) => s.bidPeakHidden);
  const askPeakLabelEnabled = useActivePrefs((s) => s.askPeakLabelEnabled);
  const bidPeakLabelEnabled = useActivePrefs((s) => s.bidPeakLabelEnabled);
  const askPeakIntraMax = useActivePrefs((s) => s.askPeakIntraMax);
  const askPeakShowAllPrices = useActivePrefs((s) => s.askPeakShowAllPrices);
  const askPeakUntradedRankLimit = useActivePrefs((s) => optionalRankLimit(s, 'askPeakUntradedRankLimit'));
  const askPeakVisibleTimeCutoff = useActivePrefs((s) => s.askPeakVisibleTimeCutoff);
  const bidPeakIntraMax = useActivePrefs((s) => s.bidPeakIntraMax);
  const bidPeakShowAllPrices = useActivePrefs((s) => s.bidPeakShowAllPrices);
  const bidPeakUntradedRankLimit = useActivePrefs((s) => optionalRankLimit(s, 'bidPeakUntradedRankLimit'));
  const bidPeakVisibleTimeCutoff = useActivePrefs((s) => s.bidPeakVisibleTimeCutoff);
  const candleAlwaysOnTop = useActivePrefs((s) => s.candleAlwaysOnTop);
  const [visibleTimeCutoff, setVisibleTimeCutoff] = useState<VisibleTimeCutoff | null>(null);

  useEffect(() => {
    if (!chart || !cb || !isMinuteTimeframe(timeframe)) {
      setVisibleTimeCutoff(null);
      return undefined;
    }
    const timeScale = chart.timeScale();
    const update = () => {
      setVisibleTimeCutoff(rightmostVisibleCandleCutoff(
        cb.candles,
        timeScale.getVisibleRange(),
        axis,
        TIMEFRAME_TO_MS[timeframe],
      ));
    };
    update();
    timeScale.subscribeVisibleTimeRangeChange(update);
    return () => {
      timeScale.unsubscribeVisibleTimeRangeChange(update);
    };
  }, [chart, cb, cb?.candles, axis, timeframe]);

  const askVisibleTimeCutoffForRender = askPeakVisibleTimeCutoff ? visibleTimeCutoff : null;
  const bidVisibleTimeCutoffForRender = bidPeakVisibleTimeCutoff ? visibleTimeCutoff : null;
  // Historical/cache-backed days only expose preclassified families, so the
  // cutoff-aware recompute is limited to today's live path where raw OB/trade
  // snapshots still exist. Past days keep the compatibility cutoff filter.
  const canRecomputeAskCutoff = !!askVisibleTimeCutoffForRender
    && (liveObSnapshots.length > 0 || liveTradeSnapshots.length > 0 || todayAskPeakInput !== null);
  const canRecomputeBidCutoff = !!bidVisibleTimeCutoffForRender
    && (liveObSnapshots.length > 0 || liveTradeSnapshots.length > 0 || todayBidPeakInput !== null);
  // 현재가 라인용 fresh 체결가 — live.trade 를 number|null 로 환원해 memo'd
  // LiveCurrentPriceLine 에 프리미티브로 전달(재구독·per-tick churn 없음). LiveChartRoot
  // 는 SSE 틱마다 재렌더되므로 Date.now() 기반 재평가 주기가 충분하다. index 뷰는
  // liveTradeSnapshots 가 빈 배열이라 null → deriveCurrentPriceLine 이 캔들 종가로 폴백.
  const liveTradePrice = freshLiveTradePrice(liveTradeSnapshots, venue, Date.now());
  const historicalAskSeeds = useMemo(
    () => dayAskPeaks.filter((peak) => peak.date !== todayKst),
    [dayAskPeaks, todayKst],
  );
  const historicalBidSeeds = useMemo(
    () => dayBidPeaks.filter((peak) => peak.date !== todayKst),
    [dayBidPeaks, todayKst],
  );
  // cutoff(as-of) 증분 소스 — 4계열(ask/bid × dayPeaks/todayAll) 각자 누적 상태를 갖는다
  // (todayAll 은 빈 trade 로 update 하므로 dayPeaks 와 공유 불가 — 공유 시 리셋 스래싱).
  // 훅 수명 동안 인스턴스 고정(useDayAskPeaks 선례). cutoff pref 를 껐다 켜도 append-only
  // prefix-guard 가 누락분을 자가 회수하고, 종목 전환(버퍼 리셋)은 참조 불일치로 전체
  // 재소비한다. batch 는 매 틱 ob/trade 를 재스캔했으나 증분은 델타만 소비한다(ADR-0106).
  const askDayPeakSourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (askDayPeakSourceRef.current === null) askDayPeakSourceRef.current = new IncrementalPeakWallSource('ask');
  const askTodayAllSourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (askTodayAllSourceRef.current === null) askTodayAllSourceRef.current = new IncrementalPeakWallSource('ask');
  const bidDayPeakSourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (bidDayPeakSourceRef.current === null) bidDayPeakSourceRef.current = new IncrementalPeakWallSource('bid');
  const bidTodayAllSourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (bidTodayAllSourceRef.current === null) bidTodayAllSourceRef.current = new IncrementalPeakWallSource('bid');
  const renderDayAskPeaks = useMemo(
    () => canRecomputeAskCutoff && isMinuteTimeframe(timeframe)
      ? deriveDayAskPeaksIncrementalAsOf(
        askDayPeakSourceRef.current!,
        liveObSnapshots,
        liveTradeSnapshots,
        historicalAskSeeds,
        todayKst,
        todayAskPeakInput,
        askVisibleTimeCutoffForRender!.tMs,
      )
      : [...dayAskPeaks],
    [
      canRecomputeAskCutoff,
      dayAskPeaks,
      historicalAskSeeds,
      liveObSnapshots,
      liveTradeSnapshots,
      timeframe,
      askVisibleTimeCutoffForRender?.tMs,
      todayAskPeakInput,
      todayKst,
    ],
  );
  const renderTodayAllPriceAskPeak = useMemo(
    () => canRecomputeAskCutoff && isMinuteTimeframe(timeframe)
      ? deriveTodayAllPriceAskPeakIncrementalAsOf(
        askTodayAllSourceRef.current!,
        liveObSnapshots,
        historicalAskSeeds,
        todayKst,
        todayAskPeakInput,
        askVisibleTimeCutoffForRender!.tMs,
      )
      : todayAllPriceAskPeak,
    [
      canRecomputeAskCutoff,
      historicalAskSeeds,
      liveObSnapshots,
      timeframe,
      askVisibleTimeCutoffForRender?.tMs,
      todayAllPriceAskPeak,
      todayAskPeakInput,
      todayKst,
    ],
  );
  const renderDayBidPeaks = useMemo(
    () => canRecomputeBidCutoff && isMinuteTimeframe(timeframe)
      ? deriveDayBidPeaksIncrementalAsOf(
        bidDayPeakSourceRef.current!,
        liveObSnapshots,
        liveTradeSnapshots,
        historicalBidSeeds,
        todayKst,
        todayBidPeakInput,
        bidVisibleTimeCutoffForRender!.tMs,
      )
      : [...dayBidPeaks],
    [
      canRecomputeBidCutoff,
      dayBidPeaks,
      historicalBidSeeds,
      liveObSnapshots,
      liveTradeSnapshots,
      timeframe,
      bidVisibleTimeCutoffForRender?.tMs,
      todayBidPeakInput,
      todayKst,
    ],
  );
  const renderTodayAllPriceBidPeak = useMemo(
    () => canRecomputeBidCutoff && isMinuteTimeframe(timeframe)
      ? deriveTodayAllPriceBidPeakIncrementalAsOf(
        bidTodayAllSourceRef.current!,
        liveObSnapshots,
        historicalBidSeeds,
        todayKst,
        todayBidPeakInput,
        bidVisibleTimeCutoffForRender!.tMs,
      )
      : todayAllPriceBidPeak,
    [
      canRecomputeBidCutoff,
      historicalBidSeeds,
      liveObSnapshots,
      timeframe,
      bidVisibleTimeCutoffForRender?.tMs,
      todayBidPeakInput,
      todayKst,
      todayAllPriceBidPeak,
    ],
  );
  const activePaneToggles = useMemo(
    // 최상위 지표 필드는 store 가 현재 봉으로 resolve 해 둔 투영이라(PR-A #699)
    // timeframe 병합 없이 국지 override 만 얹는다.
    () => resolvePaneToggles({
      indicators: indicatorPrefs,
      forceHogaPanes,
      hogaPanes: paneTogglesOverride?.hogaPanes,
      override: {
        ...(paneTogglesOverride?.volumeEnabled !== undefined
          ? { volumeEnabled: paneTogglesOverride.volumeEnabled }
          : {}),
        ...(paneTogglesOverride?.quoteTotalsEnabled !== undefined
          ? { quoteTotalsEnabled: paneTogglesOverride.quoteTotalsEnabled }
          : {}),
        ...(paneTogglesOverride?.ratioEnabled !== undefined
          ? { ratioEnabled: paneTogglesOverride.ratioEnabled }
          : {}),
        ...(paneTogglesOverride?.fillStrengthEnabled !== undefined
          ? { fillStrengthEnabled: paneTogglesOverride.fillStrengthEnabled }
          : {}),
        ...(paneTogglesOverride?.programTradeEnabled !== undefined
          ? { programTradeEnabled: paneTogglesOverride.programTradeEnabled }
          : {}),
      },
    }),
    [
      forceHogaPanes,
      indicatorPrefs,
      paneTogglesOverride?.hogaPanes,
      paneTogglesOverride?.volumeEnabled,
      paneTogglesOverride?.quoteTotalsEnabled,
      paneTogglesOverride?.ratioEnabled,
      paneTogglesOverride?.fillStrengthEnabled,
      paneTogglesOverride?.programTradeEnabled,
    ],
  );
  const candlePaneContext = useMemo<CandlePaneContext>(
    () => ({ muteAuctionCandles: venue === 'KRX' }),
    [venue],
  );
  const volumeFillStrengthCumulative = useActivePrefs((p) => p.volumeFillStrengthCumulative);

  useEffect(() => {
    if (!chart || !cb) return;
    const specs = paneSpecsForTimeframe(timeframe, activePaneToggles, paneOrder);
    paneSpecsRef.current = specs;
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      // separator 드래그 중에는 lwc 가 stretch 를 소유한다 — 여기서 재적용하면
      // 드래그와 싸운다. 종료 시 setPaneStretch 가 paneStretch 를 갱신해 이
      // effect 가 다시 돌며 최종값을 재적용한다(멱등).
      if (paneDragRef.current) return;
      try {
        const panes = chart.panes();
        if (panes.length < specs.length) {
          requestAnimationFrame(apply);
          return;
        }
        panes.forEach((p, i) => {
          const spec = specs[i];
          if (!spec || typeof p.setStretchFactor !== 'function') return;
          // 저장된 Pane Stretch 우선, 없으면 스펙 기본값. 저장값 재적용은
          // 멱등이라 cb identity churn(실시간 틱·refetch)이 사용자 드래그를
          // 스펙 기본값으로 되돌리던 스냅백이 사라진다(#703).
          p.setStretchFactor(paneStretch[spec.name] ?? spec.stretch);
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
  }, [chart, activePaneToggles, cb, timeframe, paneOrder, paneStretch]);

  // separator 드래그 캡처 — lwc(검증: 5.2.0)는 pane resize 종료 이벤트를 공개
  // API 로 제공하지 않는다. 핸들은 inline `cursor: row-resize` 를 가진 유일한
  // 차트 내부 요소이므로 pointerdown 에서 드래그 시작을 식별하고, pointerup 에서
  // lwc 가 드래그 중 갱신한 각 pane 의 stretch 를 읽어 Pane Stretch 로 저장한다.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !chart) return;
    const isSeparatorHandle = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement && t.style.cursor === 'row-resize';
    // 진행 중 드래그의 pointerup 리스너 핸들 — cleanup 이 언마운트 시점에도
    // 확실히 떼도록 effect 스코프에 잡아둔다(드래그 도중 차트 teardown 시 window
    // 리스너 누수 방지).
    let activeOnUp: (() => void) | null = null;
    const detachOnUp = () => {
      if (!activeOnUp) return;
      window.removeEventListener('pointerup', activeOnUp);
      window.removeEventListener('pointercancel', activeOnUp);
      activeOnUp = null;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!isSeparatorHandle(e.target)) return;
      paneDragRef.current = true;
      const onUp = () => {
        detachOnUp();
        paneDragRef.current = false;
        try {
          const specs = paneSpecsRef.current;
          const patch: PaneStretchMap = {};
          chart.panes().forEach((p, i) => {
            const name = specs[i]?.name;
            if (name === undefined || typeof p.getStretchFactor !== 'function') return;
            const f = p.getStretchFactor();
            if (Number.isFinite(f) && f > 0) patch[name] = f;
          });
          if (Object.keys(patch).length > 0) setPaneStretch(patch);
        } catch {
          // chart torn down mid-drag
        }
      };
      activeOnUp = onUp;
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown, true);
      detachOnUp();
      paneDragRef.current = false;
    };
  }, [chart, setPaneStretch]);

  // 고저 극값 라벨이 피할 매도/매수 최대벽 도킹 라벨 입력(가격·선 끝 시각·텍스트 —
  // 픽셀 아님). 좌표 변환은 HighLowAnnotationOverlay 렌더 본문이 매 프레임 수행한다:
  // priceToCoordinate 는 가격축 스케일 스냅샷이라, 여기(데이터-deps memo)서 구우면
  // 오토스케일·팬/줌·pane 토글로 축이 리스케일돼도 재계산되지 않아 회피 rect 가 실제
  // 칩 위치와 어긋난다. 게이트는 도킹 라벨이 **실제로 그려지는** 조건과 동일해야 한다
  // (LivePeakWallDockedLabels 미러: enabled && !hidden && labelEnabled) — 안 그려지는
  // 라벨을 피해 극값 라벨이 pane 안쪽으로 밀리던 유령 회피의 수정. 가시범위/rank 컷은
  // 렌더 단 2D 교차 검사가 흡수한다(화면 밖 칩 rect 는 극값 라벨과 교차하지 않음).
  const highLowAvoidWallLabels = useMemo(() => {
    if (!cb || !isMinuteTimeframe(timeframe)) return [];
    const askLabelsOn = askPeakEnabled && !askPeakWallHidden && askPeakLabelEnabled;
    const bidLabelsOn = bidPeakEnabled && !bidPeakWallHidden && bidPeakLabelEnabled;
    const wallSegments = [
      ...(askLabelsOn
        ? buildAskPeakOverlaySegments({
          dayAskPeaks: renderDayAskPeaks,
          todayAllPriceAskPeak: renderTodayAllPriceAskPeak,
          segments: cb.segments,
          candles: cb.candles,
          axis,
          todayKst,
          baselineStyle: HIGH_LOW_AVOID_BASELINE_STYLE,
          allPriceStyle: HIGH_LOW_AVOID_BASELINE_STYLE,
          intraMax: askPeakIntraMax,
          showAllPrices: askPeakShowAllPrices,
          untradedRankLimit: askPeakUntradedRankLimit,
          visibleTimeCutoff: askVisibleTimeCutoffForRender,
        })
        : []),
      ...(bidLabelsOn
        ? buildBidPeakOverlaySegments({
          dayBidPeaks: renderDayBidPeaks,
          todayAllPriceBidPeak: renderTodayAllPriceBidPeak,
          segments: cb.segments,
          candles: cb.candles,
          axis,
          todayKst,
          baselineStyle: HIGH_LOW_AVOID_BASELINE_STYLE,
          allPriceStyle: HIGH_LOW_AVOID_BASELINE_STYLE,
          intraMax: bidPeakIntraMax,
          showAllPrices: bidPeakShowAllPrices,
          untradedRankLimit: bidPeakUntradedRankLimit,
          visibleTimeCutoff: bidVisibleTimeCutoffForRender,
        })
        : []),
    ];
    // livePeakWallDockedLabelsFromSegments 미러: 라벨 없는 세그먼트 제외 + 가격별 최대
    // qty 1개(같은 가격에 라벨 칩은 하나만 도킹됨).
    const bestByPrice = new Map<number, (typeof wallSegments)[number]>();
    for (const segment of wallSegments) {
      if (segment.label === '' || !Number.isFinite(segment.price)) continue;
      const prev = bestByPrice.get(segment.price);
      if (!prev || segment.qty > prev.qty) bestByPrice.set(segment.price, segment);
    }
    return [...bestByPrice.values()].map((s) => ({
      price: s.price,
      time1: s.time1,
      label: s.label,
    }));
  }, [
    askPeakEnabled,
    askPeakIntraMax,
    askPeakLabelEnabled,
    askPeakShowAllPrices,
    askPeakUntradedRankLimit,
    askPeakWallHidden,
    askVisibleTimeCutoffForRender,
    axis,
    bidPeakEnabled,
    bidPeakIntraMax,
    bidPeakLabelEnabled,
    bidPeakShowAllPrices,
    bidPeakUntradedRankLimit,
    bidPeakWallHidden,
    bidVisibleTimeCutoffForRender,
    cb,
    renderDayAskPeaks,
    renderDayBidPeaks,
    renderTodayAllPriceAskPeak,
    renderTodayAllPriceBidPeak,
    timeframe,
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
        if (publishedCursorMsRef.current === cursorMs && store.cursorMs === cursorMs) {
          scheduleSidebarCursor(cursorMs);
          return;
        }
        publishedCursorMsRef.current = cursorMs;
        store.setCursor(cursorMs);
        scheduleSidebarCursor(cursorMs);
      };
      const t = typeof virtualTime === 'number'
        ? virtualTime
        : (typeof pointX === 'number' ? chart.timeScale().coordinateToTime(pointX) : null);
      const lastMs = lastCandleMsRef.current;
      // No usable time while still inside the chart surface means the pointer
      // is over a blank band. Two kinds, distinguished by X:
      //  - Right-offset whitespace (X right of the last candle): lwc reports no
      //    time past the last bar (param.time undefined, coordinateToTime null),
      //    so this branch — not the numeric one below — is the live path there.
      //    It is temporally "now/future" → drop spot mode, return the sidebar to
      //    latest (WS), same clear path as mouse-leave.
      //  - Internal blank band (X on/left of the last candle): keep the sidebar
      //    pinned to the latest concrete candle.
      if (typeof t !== 'number' || axis.segments.length === 0) {
        if (
          lastMs !== null
          && typeof pointX === 'number'
          && axis.segments.length > 0
        ) {
          const lastCoord = chart.timeScale().timeToCoordinate(
            realMsToVirtualSeconds(axis, lastMs) as Time,
          );
          if (lastCoord !== null && pointX > lastCoord) {
            publishBasisHover(null);
            publishCursorActive(false);
            store.clearCursor();
            clearSidebarCursor();
            publishedCursorMsRef.current = null;
            return;
          }
        }
        if (lastMs !== null) {
          publishBasisHover(kstDateFromMs(lastMs));
          publishCursorActive(true);
          publishCursorMs(lastMs);
          return;
        }
        publishCursorActive(false);
        store.clearCursor();
        clearSidebarCursor();
        publishedCursorMsRef.current = null;
        return;
      }
      // ChartStage.tsx:197 pattern — param.time is virtual-axis seconds.
      // Convert to virtual-ms, then real Unix-ms via axis.toReal().
      const realMs = axis.toReal(t * 1000);
      // Right-offset whitespace past the last candle (beyond the last candle's
      // half-bucket snap window): this x-slot has no candle and is temporally
      // "now/future", so drop spot mode and return the sidebar to latest (WS)
      // mode — same clear path as mouse-leave. Consistent with the click
      // handler, which already publishes null past the last candle.
      const bucketMs = bucketMsRef.current;
      if (lastMs !== null && realMs > lastMs + (bucketMs > 0 ? bucketMs / 2 : 0)) {
        publishBasisHover(null);
        publishCursorActive(false);
        store.clearCursor();
        clearSidebarCursor();
        publishedCursorMsRef.current = null;
        return;
      }
      const cursorMs = nearestCandleMs(realMs, candleMsRef.current, bucketMsRef.current);
      publishBasisHover(kstDateFromMs(cursorMs));
      publishCursorActive(true);
      publishCursorMs(cursorMs);
    },
    [axis, chart, clearSidebarCursor, onCandleBasisHover, onCursorActiveChange, scheduleSidebarCursor],
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
      cancelPendingSidebarCursor();
      useLiveCursorStore.getState().resetCursor();
      return;
    }
    let pending: number | null = null;
    let pendingLeaveClear: number | null = null;
    const cancelPendingLeaveClear = () => {
      if (pendingLeaveClear === null) return;
      window.clearTimeout(pendingLeaveClear);
      pendingLeaveClear = null;
    };
    const clearCursorForLeave = () => {
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
      clearSidebarCursor();
    };
    const handler = (param: {
      time?: unknown;
      point?: { x: number } | null;
      sourceEvent?: { localX?: unknown };
      seriesData?: unknown;
    }) => {
      const separatorX =
        typeof param.sourceEvent?.localX === 'number'
          && Number.isFinite(param.sourceEvent.localX)
          ? param.sourceEvent.localX
          : null;
      if (param.point == null && separatorX !== null) {
        cancelPendingLeaveClear();
        if (pending !== null) cancelAnimationFrame(pending);
        pending = requestAnimationFrame(() => {
          pending = null;
          const t = typeof param.time === 'number'
            ? param.time
            : (readNumericCrosshairTimeFromSeriesData(param.seriesData)
              ?? chart.timeScale().coordinateToTime(separatorX));
          publishCursorHover(t, separatorX);
        });
        return;
      }
      // Cursor left the chart pane entirely (mouse-leave) → return the sidebar
      // to latest mode. Cancel any pending valid-hover write so a queued rAF
      // can't re-set the cursor after the pointer is already off-chart.
      if (param.point == null) {
        if (pending !== null) { cancelAnimationFrame(pending); pending = null; }
        cancelPendingLeaveClear();
        pendingLeaveClear = window.setTimeout(() => {
          pendingLeaveClear = null;
          clearCursorForLeave();
        }, CURSOR_LEAVE_CLEAR_DELAY_MS);
        return;
      }
      cancelPendingLeaveClear();
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
      cancelPendingLeaveClear();
      publishedBasisDateRef.current = null;
      onCandleBasisHover?.(null);
      // Preserve user context only while the chart instance is active; on teardown
      // (view key / timeframe navigation) reset both cursor states.
      if (publishedCursorActiveRef.current !== false) {
        publishedCursorActiveRef.current = false;
        onCursorActiveChange?.(false);
      }
      publishedCursorMsRef.current = null;
      cancelPendingSidebarCursor();
      useLiveCursorStore.getState().resetCursor();
    };
  }, [
    chart,
    axis,
    timeframe,
    cancelPendingSidebarCursor,
    clearSidebarCursor,
    onCursorActiveChange,
    onCandleBasisHover,
    publishCursorHover,
  ]);

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

  const showTradeVolumePocOverlay = shouldShowTradeVolumePocOverlay(
    timeframe,
    forceHogaPanes,
    tradeVolumePocs.length,
  );
  const depthHeatmapPoints = useMemo(() => depthHeatmapFromWire(depthHeatmap), [depthHeatmap]);
  const depthHeatmapEnabledStore = useLivePageStore((s) => s.depthHeatmapEnabled);
  const showDepthHeatmapOverlay = shouldShowDepthHeatmapOverlay(
    timeframe,
    depthHeatmapEnabledStore,
    depthHeatmapPoints.length,
  );

  return (
    <div
      data-testid="live-chart-root"
      onContextMenu={(event) => event.preventDefault()}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div
        ref={containerRef}
        className="live-chart-canvas"
        style={{ width: '100%', height: '100%', background: 'var(--bg-card)' }}
      />
      {chart && cb && axis.segments.length > 0 && (
        <>
          {candleAlwaysOnTop && (
            <>
              <MovingAverageOverlay chart={chart} bundle={cb} axis={axis} />
              <DailyMovingAverageOverlay chart={chart} bundle={cb} axis={axis} code={code} timeframe={timeframe} venue={venue} todayKst={todayKst} dailyCandleKisEnabled={dailyCandleKisEnabled} override={dailyMovingAverageOverride} />
            </>
          )}
          {paneSpecsForTimeframe(timeframe, activePaneToggles, paneOrder).map((spec, i) => (
            <RangeSeriesPane
              key={spec.name}
              chart={chart}
              // Hoga panes get the live bundle. Candle/investor panes, and volume
              // unless its cumulative fill-strength line is enabled, get the stable
              // chartBundle so an SSE tick doesn't re-project the candle path.
              bundle={
                spec.name === 'ratio'
                  ? (paneRatioBundle ?? cb)
                  : (spec.name === 'quote-totals' || spec.name === 'fill-strength')
                    ? (paneHogaBundle ?? cb)
                    : spec.name === 'volume'
                      ? (volumeFillStrengthCumulative ? (bundle ?? cb) : cb)
                      : spec.live
                        ? (bundle ?? cb)
                        : cb
              }
              axis={axis}
              paneIndex={i}
              spec={spec}
              contextOverride={spec.name === 'candle' ? candlePaneContext : undefined}
              forceSetData={isCalendarTimeframe(timeframe) && spec.name === 'candle'}
              candleAlwaysOnTop={candleAlwaysOnTop}
              onPrimarySeriesReady={handleSeriesReady}
              onPrimarySeriesGone={handleSeriesGone}
              onLegendReady={handleLegendReady}
              onLegendGone={handleLegendGone}
            />
          ))}
          {!candleAlwaysOnTop && (
            <>
              <MovingAverageOverlay chart={chart} bundle={cb} axis={axis} />
              <DailyMovingAverageOverlay chart={chart} bundle={cb} axis={axis} code={code} timeframe={timeframe} venue={venue} todayKst={todayKst} dailyCandleKisEnabled={dailyCandleKisEnabled} override={dailyMovingAverageOverride} />
            </>
          )}
          <LiveCurrentPriceLine paneSeries={paneSeries} bundle={cb} code={code} liveTradePrice={liveTradePrice} />
          {isMinuteTimeframe(timeframe) && (
            <QuoteLevelLines paneSeries={paneSeries} bundle={paneRatioBundle ?? cb} />
          )}
          {isMinuteTimeframe(timeframe) && (
            <LiveAskPeakSegments
              paneSeries={paneSeries}
              axis={axis}
              dayAskPeaks={renderDayAskPeaks}
              todayAllPriceAskPeak={renderTodayAllPriceAskPeak}
              segments={cb.segments}
              candles={cb.candles}
              todayKst={todayKst}
              untradedRankLimit={askPeakUntradedRankLimit}
              visibleTimeCutoff={askVisibleTimeCutoffForRender}
            />
          )}
          {isMinuteTimeframe(timeframe) && (
            <LiveBidPeakSegments
              paneSeries={paneSeries}
              axis={axis}
              dayBidPeaks={renderDayBidPeaks}
              todayAllPriceBidPeak={renderTodayAllPriceBidPeak}
              segments={cb.segments}
              candles={cb.candles}
              todayKst={todayKst}
              untradedRankLimit={bidPeakUntradedRankLimit}
              visibleTimeCutoff={bidVisibleTimeCutoffForRender}
            />
          )}
          {isMinuteTimeframe(timeframe) && (
            <LivePeakWallDockedLabels
              paneSeries={paneSeries}
              axis={axis}
              dayAskPeaks={renderDayAskPeaks}
              todayAllPriceAskPeak={renderTodayAllPriceAskPeak}
              dayBidPeaks={renderDayBidPeaks}
              todayAllPriceBidPeak={renderTodayAllPriceBidPeak}
              segments={cb.segments}
              candles={cb.candles}
              todayKst={todayKst}
              askVisibleTimeCutoff={askVisibleTimeCutoffForRender}
              bidVisibleTimeCutoff={bidVisibleTimeCutoffForRender}
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
          {showDepthHeatmapOverlay && (
            <DepthHeatmapOverlay
              chart={chart}
              paneSeries={paneSeries}
              axis={axis}
              points={depthHeatmapPoints}
            />
          )}
          <DrawingOverlay
            chart={chart}
            axis={axis}
            paneSeries={paneSeries}
            onChartHoverPassthrough={handleDrawingOverlayHover}
            bucketMs={cb?.bucket_ms ?? undefined}
            candles={cb?.candles}
          />
          {/* After DrawingOverlay so the legend's ✕/eye buttons paint above the
              drawing canvas; the container is pointer-transparent so the
              crosshair + drawing hover still work underneath it. */}
          {/* P1: `cb`(캔들 경로 번들)를 memo 신선화 신호로 전달. SSE 호가 틱엔 `cb`
              식별자가 안정(2026-06-09 bundle-split)이라 레전드 재렌더가 차단되고, 캔들
              갱신 때만 새 ref가 돼 latest 값을 신선화한다. ref-during-render 불필요. */}
          <PaneLegendOverlay
            chart={chart}
            timeframe={timeframe}
            paneToggles={activePaneToggles}
            dataEpoch={cb}
          />
          <CandleTooltip chart={chart} bundle={cb} quoteBundle={paneRatioBundle} axis={axis} paneSeries={paneSeries} timeframe={timeframe} />
          {/* 고저 극값 라벨 — 보이는 범위의 최고/최저봉에 극값 대비율 라벨. cb(안정)·viewport
              구독이라 SSE 틱엔 미재렌더, 팬/줌·캔들 갱신 시에만 재계산. 토글 self-gate. */}
          <HighLowAnnotationOverlay
            chart={chart}
            bundle={cb}
            axis={axis}
            paneSeries={paneSeries}
            timeframe={timeframe}
            avoidWallLabels={highLowAvoidWallLabels}
          />
          {isMinuteTimeframe(timeframe) && hogaBundle && (
            <PriceLevelDotsOverlay chart={chart} bundle={hogaBundle} axis={axis} paneSeries={paneSeries} />
          )}
          <DrawingPropertyPanel />
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
          <AuctionWindowOverlay chart={chart} axis={axis} enabled={venue === 'KRX'} />
        </>
      )}
      {/* Reveal cover — masks the chart + its overlays while the initial
          viewport's barSpacing settles (see chartReady gate above), then fades
          out so the candles appear once at the final zoom instead of flashing
          in at lightweight-charts' default ~60-bar fit and zooming out.
          bg-card matches the chart background, so the cover reads as the empty
          chart surface during a cold load.

          z-index 30 is LOAD-BEARING: lightweight-charts paints its canvases at
          `position:absolute; z-index:1` and the pane overlays at z-index 4–20,
          so a cover at the default `auto` paints BELOW them and masks NOTHING
          (verified 2026-07-08 via /browse: forcing opacity:1 left the whole
          chart visible — the hoga panes, which resolve ~2s before the candles,
          bled through and produced the "hoga pane alone" cold-load desync).
          30 sits above all pane content (≤20) and below the drawing toolbar
          (z:49-50) so the toolbar/右 10호가 ladder stay put. The loading/clamp
          notes below carry z-index 31 to remain visible through the mask.

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
          zIndex: 30,
        }}
      />
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
            fontSize: 'var(--text-sm)', zIndex: 31,
          }}
        >
          {warnSummary.hasRateLimit ? 'KIS 호출 한도로 지연 중 — 잠시 후 재시도…' : '분봉 불러오는 중…'}
        </div>
      )}
      {/* 호가 홀드 노트: 캔들은 도착했지만 호가 경로 settle을 기다리며 reveal이 홀드된 동안
          표시. 침묵 커버가 "행"처럼 보이는 걸 막는다. !chartReady 가드로 ungated 팬 경로에서
          revealed 차트 위 플래시를 막는다. 커버 div 뒤에 렌더돼 커버 위에 페인트된다. */}
      {cb !== null && cb.candles.length > 0 && !chartReady && isHogaLoading && (
        <div
          data-testid="hoga-loading-note"
          style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', color: 'var(--fg-dimmer)',
            fontSize: 'var(--text-sm)', zIndex: 31,
          }}
        >
          지표 불러오는 중…
        </div>
      )}
      {/* bottom-left 상태 칩 스택: 부분로딩(rate-limit, 위) + 클램프(아래). 둘 다
          하단-좌측이라 한 flex 컬럼으로 묶어 겹침을 막는다(드물게 동시 발생). */}
      {(clampEngaged || (cb !== null && cb.candles.length > 0 && warnSummary.count > 0)) && (
        <div
          style={{
            position: 'absolute', bottom: 'var(--space-md)', left: 'var(--space-md)',
            display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)',
            pointerEvents: 'none', zIndex: 31,
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
