import { useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
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
  chartCrosshairOptions,
  CHART_LAYOUT_OPTIONS,
  CHART_TIMESCALE_OPTIONS,
} from '../util/chartScale';
import { createVirtualAxis, type VirtualAxis } from '../util/virtualAxis';
import RangeSeriesPane, { type PaneBundleKind, type SeriesLegendMeta } from '../chart/RangeSeriesPane';
import { usePaneLegendRegistry } from './indicators/paneLegendRegistry';
import { paneSpecsForTimeframe } from './paneSpecsForTimeframe';
import { usePaneFolding } from './usePaneFolding';
import { FoldedPaneNotice } from './FoldedPaneNotice';
import { HogaMissingNotice } from './HogaMissingNotice';
import { deriveHogaMissingDetail, deriveHogaMissingNotice } from './hogaMissingNotice';
import { CandleEmptyState } from './CandleEmptyState';
import { deriveSourceBadge } from './sourceBadge';
import type { CandleEmptyState as CandleEmptyStateValue } from './candleEmptyState';
import { resolvePaneToggles } from './indicators/indicatorPaneProfiles';
import DayBoundaryOverlay from '../chart/DayBoundaryOverlay';
import {
  NO_DAY_BOUNDARY_TICKS,
  resolveDayBoundaryTicks,
  sameDayBoundaryTicks,
  type DayBoundaryTick,
} from '../chart/sessionSpans';
import CursorSyncCrosshair from '../chart/CursorSyncCrosshair';
import { canPublishSyncCursor, isSyncConsumerTimeframe } from '../chart/cursorSync';
import { canPublishRangeSync, isRangeSyncFollower } from '../chart/rangeSync';
import { useRangeSyncPublish, useRangeSyncFollow } from './useRangeSync';
import { canPublishTimeframeJump, isTimeframeJumpTarget } from '../chart/timeframeJump';
import { useTimeframeJump, type MinuteJumpState } from './useTimeframeJump';
import type { Candle } from '../api/types';
import StudySavedRangeBandHost from '../studyViews/StudySavedRangeBandHost';
import { savedRangeAnchorTs } from './savedRangeAnchor';
import { jumpTargetMs } from './minuteJumpDestination';
import type { StudySavedRangeMarks } from '../studyViews/studyDailyContext';
import {
  type LiveMAConfig,
  type LiveTimeframe,
  isMinuteTimeframe,
  isCalendarTimeframe,
} from '../state/livePage';
import {
  WindowViewContext,
  useHistoricalRangeActions,
  useIndicatorActions,
  useWindowIndicator,
  useWindowPaneOrder,
  useWindowPaneStretch,
  useWindowScopeId,
  useWindowViewGuard,
} from './workspace/windowView';
import { useActivePrefs, useChartPrefsStore } from '../state/chartPrefs';
import type { LiveVenueOption } from '../state/liveVenue';
import type { LiveTodayAskPeak, LiveTodayBidPeak } from '../api/liveSeries';
import { TIMEFRAME_TO_MS, type AskPeak, type BidPeak, type RangeBundle, type RangeMissingDate, type DepthHeatmapPointWire } from '../api/types';
import { PAST_CANDLES_MAX_DAYS } from './liveDateTime';
import { initialVisibleMinuteBarsFor, liveVenueSessionBoundsMs } from './liveVenuePolicy';
import { minuteRestoreGeometry, minuteRightOffsetBars } from './minuteViewportPolicy';
import { summarizeWarnings, type LiveDataWarning } from './liveDataWarnings';
import { useViewportBackfill } from './useViewportBackfill';
import {
  viewportFromRanges,
  computeRestoreRange,
  realMsToVirtualSeconds,
  type TabViewport,
} from './viewportAnchor';
import { useWheelInteractions } from './useWheelInteractions';
import { useLiveCursorStore, type SidebarCursorOrigin } from './useLiveCursorStore';
import {
  alignSidebarCursorMs,
  shouldPublishSidebarCursor,
  sidebarCursorPublishDelayMs,
} from './sidebarCursorRateLimit';
import MovingAverageOverlay from './indicators/MovingAverageOverlay';
import DailyMovingAverageOverlay from './indicators/DailyMovingAverageOverlay';
import LiveCurrentPriceLine from './LiveCurrentPriceLine';
import QuoteLevelLines from './QuoteLevelLines';
import { freshLiveTradePrice } from './deriveCurrentPriceLine';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import type { PeakWallSegment, PeakWallLabelSide } from '../chart/AskPeakSegmentsPrimitive';
import LiveAskPeakSegments from './LiveAskPeakSegments';
import { buildPeakWallOverlaySegments } from './peakWallSegments';
import { PEAK_WALL_LEGEND_RANK_LIMIT } from './peakWallVisibleRanking';
import { candleExtremesByVirtualSec, peakWallRankArrowsFromSegments } from './peakWallRankArrows';
import type { PeakWallRankArrow } from '../chart/PeakWallRankArrowsPrimitive';
import { usePeakMaFilter } from './peakWallMaFilter';
import { usePeakDailyMaFilter } from './peakWallDailyMaFilter';
import { LiveWallSurgeMarkers } from './LiveWallSurgeMarkers';

/** 번들에 wall_surge 가 없을 때 넘길 **안정 참조** — 인라인 `[]` 는 매 렌더 새 배열이라
 *  memo 를 매번 깨뜨린다. */
const EMPTY_WALL_SURGE: readonly never[] = [];
import LiveBidPeakSegments from './LiveBidPeakSegments';
import {
  deriveDayAskPeaksIncrementalAsOf,
} from './useDayAskPeaks';
import {
  deriveDayBidPeaksIncrementalAsOf,
} from './useDayBidPeaks';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';
import LivePeakWallDockedLabels from './LivePeakWallDockedLabels';
import {
  rightmostVisibleCandleCutoff,
  type VisibleTimeCutoff,
} from './peakWallVisibleCutoff';
import TradeVolumePocOverlay from './TradeVolumePocOverlay';
import DepthHeatmapOverlay from './DepthHeatmapOverlay';
import DepthDeltaOverlay from './DepthDeltaOverlay';
import type { DepthDeltaPoint } from './depthDelta';
import { depthHeatmapFromWire } from './depthHeatmapWire';
import DrawingOverlay from '../chart/DrawingOverlay';
import DrawingPropertyPanel from '../chart/DrawingPropertyPanel';
import PaneLegendOverlay from './PaneLegendOverlay';
import CandleTooltip from './CandleTooltip';
import HighLowLabelsHost from './HighLowLabelsHost';
import PriceLevelDotsOverlay from './PriceLevelDotsOverlay';
import type { CandlePaneContext } from '../chart/projectors/candle';
import type { PaneId } from '../chart/drawing/types';
import type { PaneStretchMap } from '../chart/paneOrder';
import type { BoundPaneSpec } from '../chart/paneSpecs';
import { useDrawingHost } from '../chart/useDrawingHost';
import { drawingBarMsFor, drawingScopeFor } from '../state/drawings';
import type { TradeVolumePoc } from './tradeVolumePoc';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';

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
  // 크로스헤어 축 라벨 칩 배경 — DESIGN.md §Color 가 크로스헤어를 accent 의
  // 승인된 사용처로 명시한다. lwc 기본값(#131722)은 테마를 안 따라가서 다크
  // 테마 차트 배경과 1.00~1.04:1 로 융합됐다(chartCrosshairOptions 주석).
  accent: ['--accent', '#f0b429'],
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
/** 동기화 소비자가 없는 봉(W/M)의 캔들 자리. identity 가 안정적이어야 소비자의
 *  memo 가 헛돌지 않는다 — 매번 새 `[]` 를 내면 그 창의 다리가 프레임마다 재생성된다. */
const EMPTY_SYNC_CANDLES: readonly Candle[] = [];
const EMPTY_ASK_PEAKS: readonly AskPeak[] = [];
const EMPTY_BID_PEAKS: readonly BidPeak[] = [];
const EMPTY_OB_SNAPSHOTS: ReadonlyArray<ObSnapshot> = [];
const EMPTY_TRADE_SNAPSHOTS: ReadonlyArray<TradeSnapshot> = [];
const EMPTY_CANDLE_MS: readonly number[] = [];
/** 모듈 상수 — 렌더마다 `[]` 를 새로 만들면 캔들을 deps 로 쓰는 훅이 매 렌더 돈다. */
const EMPTY_CANDLES: readonly Candle[] = [];
const CURSOR_LEAVE_CLEAR_DELAY_MS = 120;
/** Leading+trailing throttle window for sidebarCursorMs publishes. The first
 * hover after a quiet window publishes immediately; while the pointer keeps
 * moving, the latest aligned cursor is published once per window — a trailing
 * debounce here starved the sidebar for the entire duration of a continuous
 * sweep (it only fired after the pointer stopped). */
const LIVE_SIDEBAR_CURSOR_THROTTLE_MS = 120;
/** 번들이 아직 없을 때 일봉 MA 필터에 넘기는 빈 캔들 — 매 렌더 새 배열을 만들면 훅의
 *  memo 가 매번 깨진다. */
const EMPTY_CANDLES_FOR_DAILY_MA: readonly Candle[] = [];

const HIGH_LOW_AVOID_BASELINE_STYLE = { color: '', lineWidth: 1 };
// 회피 입력의 빈 상태 — **공유 상수**여야 memo 결과가 참조로 안정되어 하위 스냅샷
// effect 가 매 렌더 다시 돌지 않는다(빈 배열 리터럴은 매번 새 참조다).
const EMPTY_AVOID_SEGMENTS: readonly PeakWallSegment[] = [];
const EMPTY_AVOID_ARROWS: readonly PeakWallRankArrow[] = [];
/** 캔들·호가가 settle된 뒤 **사이드카 지표만** 더 기다리는 상한.
 *
 * ## 왜 캡이 (다시) 있는가
 *
 * 이 캡은 #479 에서 도입됐다가 #579 가 제거했고, 2026-08-19 사용자 결정으로
 * 복원됐다. 취향의 왕복이 아니라 **전제가 실측으로 반박된** 경우다:
 *
 * - #579 의 근거는 "사이드카는 빠르다" 였다(실측 220ms). 캔들 콜드 ~1s 옆에서
 *   0.2s 는 공짜라, 캡 없이 다 같이 등장시키는 편이 나았다("기다림 > 따로 뜸").
 * - 그 뒤 실측이 그 전제를 깼다. 콜드 5거래일 창에서 호가 44ms 대 **사이드카
 *   4.68s**, 한 달 창은 **11.7s**(아래 지표 문구 주석에 기록). 2026-08-19
 *   `/live` 조사에서도 `/api/range` 가 콜드 2.6s, 서버 slow-log 09시대 19건
 *   평균 5.0s·최대 12.3s 였다.
 * - 즉 "0.2s 더 기다리기" 가 실제로는 "최대 11.7초 단색 커버 응시" 였다.
 *   그 구간에서는 따로 뜨는 편이 낫다 — 캡은 그 꼬리만 자른다.
 *
 * 700ms 는 #479 가 심사했던 값 그대로다. 빠른 경로(사이드카 220ms + vdist 의
 * 캔들-후행 체인 ~0.2s)는 캡 안에 들어오므로 **한 장면 등장이 그대로 유지되고**,
 * 잘리는 것은 rate-limit·넓은 창 같은 꼬리뿐이다.
 *
 * 대가: 캡이 발화한 뒤 사이드카가 도착하면 그 pane 이 늦게 채워진다. pane 멤버십
 * 자체는 토글·타임프레임으로만 정해지므로(`paneSpecsForTimeframe`) 데이터 도착이
 * pane 을 새로 만들지는 않지만, 빈 pane 을 lwc 가 지웠다가 되살리는 경로가 있어
 * 리플로우가 보일 수 있다. 11.7초 커버와 맞바꾼 값이다. */
export const SIDECAR_REVEAL_CAP_MS = 700;
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
  /** 호가 결손 사유 — **번들과 별도 경로**다(#1133).
   *
   * 번들에도 같은 값이 실려 있지만(`RangeBundle.missing_dates`) 그 그릇은 캔들이
   * 없으면 통째로 null 이 된다. 사유는 데이터가 없을 때 존재하는 값이라 그때 사라지면
   * 쓸모가 없다 — 자격증명 미설정·벤더 장애로 캔들이 안 오는 경우가 정확히 그렇다.
   * 미지정이면 번들에서 읽어(구 호출부·`/study` 하위호환) 동작이 이전과 같다. */
  hogaMissingDates?: readonly RangeMissingDate[];
  /** 미캡처(`not_captured`) 날짜도 안내할 것인가. **`/study` 만 켠다** — 근거는
   *  `hogaMissingNotice.ts` 의 `includeNotCaptured` 주석. */
  showNotCapturedNotice?: boolean;
  /** 캔들이 없을 때의 빈 상태(#1133 후속). 판별은 `useLiveBundle` 이 한다 — 활성 캔들
   *  쿼리가 타임프레임·우회 설정에 따라 넷으로 갈려 여기서는 고를 수 없다. */
  candleEmpty?: CandleEmptyStateValue | null;
  /** 빈 상태의 "다시 시도". 미지정이면 버튼을 숨긴다. */
  onRetryCandles?: () => void;
  /** Optional pane-specific bundle for ratio display when the source is already display-locked. */
  ratioBundle?: RangeBundle | null;
  /** 벤더 250일 벽에 닿았다 — **벤더 모드 전용**. 디스크 모드엔 그 벽이 없다. */
  clampEngaged: boolean;
  /** 좌측 팬 하한(YYYYMMDD) — `useLiveBundle.minuteScrollbackFloorDate`. `null`=무한.
   *  판정은 모드를 아는 훅이 하고 여기서는 나르기만 한다(그 값의 도크스트링 참조). */
  minuteScrollbackFloorDate?: string | null;
  isPastCandlesLoading: boolean;
  /** useLiveBundle.isHogaLoading — 호가 지표 경로 초기 fetch pending. reveal 커버가
   *  isPastCandlesLoading과 함께 써서 캔들+호가 pane을 한 번의 reveal로 등장시킨다.
   *  옵셔널 + 기본 false라 도입 당시 다른 마운트·기존 테스트가 무변경으로 settled. */
  isHogaLoading?: boolean;
  /** 캔들·호가 외의 오버레이 데이터(mode=sidecar 최대벽·POC·거래량분포·프로그램매매 +
   *  일봉MA)가 초기 fetch pending인지. LivePage가 isSidecarLoading || isDailyMaLoading으로
   *  OR해 전달한다. reveal 커버가 캔들·호가와 함께 써서 이 지표들이 캔들과 한 번의 reveal로
   *  등장하게 한다(장면1 — 캡 없음, 무제한 홀드). settle(성공·에러) 시 반드시 해제되므로
   *  커버가 고착되지 않는다. 옵셔널+기본 false라 index·기존 테스트는 무변경. */
  isSidecarLoading?: boolean;
  /** useLiveBundle.isExtending. false-edge = 한 스텝 settle → 진행 루프 다음 스텝 판정. */
  isExtending?: boolean;
  /** Coverage-gap 백필(A안): 활성 range 지표가 도달한 가장 최근 from_date. 캔들이 병합
   * 캐시로 더 과거까지 복원돼도 지표가 이 날짜까지만 있으면 useViewportBackfill이 range
   * 창을 확장한다. 옵셔널+기본 null이라 기존 테스트는 무변경. */
  indicatorCoverageFromDate?: string | null;
  /** 지금 range가 요청 중인 창의 from — coverage 스텝 base의 null-fallback. */
  rangeWindowFromDate?: string | null;
  /** 지금 서빙 중인 과거 캔들 창의 from(응답 echo). 웜 캐시로 채워진 좌측 팬 스텝은
   * fetch가 없어 `isExtending` 하강 엣지를 만들지 않으므로, 진행 루프가 이 값으로
   * 스텝 완료를 판정한다(#1328). 옵셔널+기본 null이라 기존 호출부는 무변경. */
  settledFromDate?: string | null;
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
  /** Raw backend today ask-peak payload, used only for cutoff-aware live recomputation. */
  todayAskPeakInput?: LiveTodayAskPeak | null;
  /** LivePage의 useDayBidPeaks 결과(거래일별) — LiveBidPeakSegments에 전달. */
  dayBidPeaks?: readonly BidPeak[];
  /** Backend today all-price bid peak — optional so existing tests/callers omit it safely. */
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
  /** 오늘의 단별 잔량 증감 버킷. 과거일 소스가 없는 오늘 전용 지표라 wire 를 거치지 않고
   *  도메인 그대로 받는다(`useLiveBundle().depthDeltaToday`). /study 등 SSE 가 없는
   *  호출부는 넘기지 않으면 되고, 그러면 마운트 게이트가 pointCount 0 으로 자연히 닫힌다. */
  depthDeltaToday?: readonly DepthDeltaPoint[];
  /** Snapshot restore can carry hoga panes on calendar timeframes. /live keeps the default gate. */
  forceHogaPanes?: boolean;
  /** 일봉 MA 오버레이의 KIS 일봉 fetch 허용 여부(기본 true). /study는 false로 넘겨
   * 디스크(스크리너) 일봉만 쓴다 — study의 KIS 무호출 계약 유지. */
  dailyCandleKisEnabled?: boolean;
  /** 캘린더 봉(D/W/M)의 저장 구간 밴드. null(기본) = 미표시.
   *
   *  `/study` 가 원래 유일한 생산자였고, 2026-08-21 부터 `/live` 도 저장뷰를 열면
   *  같은 값을 넘긴다(`ChartWindow`). 분봉 게이트는 아래 렌더에 있으므로 생산자는
   *  봉을 신경 쓰지 않아도 된다. */
  savedRangeBand?: StudySavedRangeMarks | null;
  /**
   * 분봉 착석 앵커 — 저장 구간 끝(B)의 실시각. null(기본) = 착석 안 함.
   *
   * 캘린더 봉은 `restoreViewport`(`studyDailyViewport`) 가 초기 커밋에서 앉히면 되지만,
   * 분봉은 그 시점에 로드된 캔들이 **최근 5거래일**뿐이라(`INITIAL_MINUTE_TRADING_DAYS`)
   * 몇 달 전 구간이 축에 없다. 그래서 이 값으로 **지연 착석**을 돌린다 — 아래 effect.
   *
   * ⚠ ms 를 받는 것이 계약이다(논리 인덱스 아님) — `savedRangeAnchor.ts` 주석.
   */
  savedRangeAnchorMs?: number | null;
  /** 열린 저장뷰의 구간 **시작일**(YYYYMMDD) — 백필이 그 날까지 워크백하게 한다
   *  (`useViewportBackfill` 3d). 봉 무관하게 넘긴다. */
  savedRangeFromDate?: string | null;
  /**
   * 이 창이 저장뷰 구간에 **얼려** 있는가(`UseLiveBundleOptions.frozenRangeFrom`).
   *
   * 켜지면 **백필 4경로를 전부 끈다**(`canTriggerBackfill`). 얼린 창의 fetch 범위는
   * 저장 구간에 고정돼 있어 `historicalFromDate` 를 아무리 밀어도 응답이 안 바뀌므로,
   * 백필이 도는 것은 순수 낭비다 — perf 로그·스토어 쓰기·재렌더만 남고 캔들은 그대로다.
   * (3a 진행 루프는 착지한 범위로 종료를 판정하는데, 그 범위가 영영 안 움직인다.)
   *
   * (`/study` 는 넘기지 않았다 — 그쪽은 `historicalFromDate` 를 소비하는 쿼리가 아예
   * 없어 백필이 이미 inert 였다. 그 페이지는 2026-08-23 에 사라졌다.)
   */
  savedRangeFrozen?: boolean;
  /**
   * 창 간 크로스헤어 동기화(옆 분봉 창 호버 → 이 일봉 창)를 켠다. `/study` 와
   * `/live` 워크스페이스가 둘 다 넘긴다.
   *
   * **동기화 범위는 창번호(링크 그룹)다** — 번호가 다른 창끼리는 어떤 동기화도 하지
   * 않는다(사용자 결정 2026-08-21). 이것은 2026-08-11 의 "범위는 종목이다 — 링크
   * 그룹이 아니다" 를 번복한 것이고, 그 사연은 `cursorSync.ts` 헤더가 갖는다.
   *
   * **종목 축은 그 안에서 설정이 정한다**: ⚙️ 설정 → 차트의 `cursorSyncCrossSymbol`
   * (기본 켬). 같은 번호여도 **핀**이 걸린 창은 종목이 다를 수 있어 이 축이 남는다.
   * 이 prop 은 **기능 자체의 on/off** 이고 범위 판정은 `resolveSyncTarget` 한 곳이다.
   *
   * 라우트를 여기서 스니핑하지 않고 **prop 으로 받는** 이유는 둘이다: 결정의
   * 소유자가 페이지이고, `/study` 워크스페이스 어댑터를 정적 import 하면 그
   * 스토어들이 `live-workspace` 청크로 끌려온다(실측 +11.5kB, `/live` 사용자에겐
   * 순수 낭비).
   */
  cursorSyncCrosshair?: boolean;
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
  /**
   * 「분봉으로」 버튼이 이 캘린더 창의 **목적지 날짜**를 읽는 통로(실시각 ms, 없으면
   * null). `onViewportCaptureReady` 와 같은 등록 패턴이다 — 좌표 변환과 캔들 배열은
   * 차트 안에만 있어서 헤더가 직접 계산할 수 없다.
   */
  onJumpSourceReady?: (readTargetMs: () => number | null) => void;
  /** 이 분봉 창에 걸린 점프의 상태 — 헤더 칩이 그린다. 걸린 것이 없으면 null. */
  onMinuteJumpChange?: (jump: { state: MinuteJumpState | null; clear: () => void }) => void;
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

/** 증감 오버레이 마운트 게이트. 히트맵과 같은 3조건이지만 소스가 오늘(SSE) 전용이라
 *  과거일만 보는 뷰포트에서는 pointCount 0 으로 자연히 닫힌다. `hidden` 은 여기 넣지
 *  않는다 — 숨김은 그리기만 끄고 마운트/레전드는 유지하는 것이 규약이다. */
export function shouldShowDepthDeltaOverlay(
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
  hogaMissingDates,
  showNotCapturedNotice = false,
  candleEmpty,
  onRetryCandles,
  ratioBundle,
  clampEngaged,
  minuteScrollbackFloorDate = null,
  isPastCandlesLoading,
  isHogaLoading = false,
  isSidecarLoading = false,
  isExtending = false,
  indicatorCoverageFromDate = null,
  rangeWindowFromDate = null,
  settledFromDate = null,
  pastDataWarnings,
  restoreViewport = null,
  dayAskPeaks = EMPTY_ASK_PEAKS,
  todayAskPeakInput = null,
  dayBidPeaks = EMPTY_BID_PEAKS,
  todayBidPeakInput = null,
  liveObSnapshots = EMPTY_OB_SNAPSHOTS,
  liveTradeSnapshots = EMPTY_TRADE_SNAPSHOTS,
  todayKst = '',
  tradeVolumePocs = [],
  depthHeatmap = [],
  depthDeltaToday = [],
  forceHogaPanes = false,
  dailyCandleKisEnabled = true,
  savedRangeBand = null,
  savedRangeAnchorMs = null,
  savedRangeFromDate = null,
  savedRangeFrozen = false,
  cursorSyncCrosshair = false,
  paneTogglesOverride,
  dailyMovingAverageOverride,
  tradeVolumePocOverride,
  onViewportCaptureReady,
  onJumpSourceReady,
  onMinuteJumpChange,
  onCursorActiveChange,
  onCandleBasisHover,
  onCandleBasisClick,
}: Props) {
  // mutable 로 두는 이유: 아래 `setContainer` 가 직접 채운다(`ref=` 에 거는 것이
  // callback ref 라서). 소비처(`useWheelInteractions` 등)는 `RefObject` 를 받지만
  // MutableRefObject 는 그대로 할당 가능하다.
  const containerRef = useRef<HTMLDivElement | null>(null);
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
  // 라이브 성분이 얹힌 그릇. `bundle` 이 없는 pre-split 호출자·테스트에서만 캔들 그릇으로
  // 떨어진다. **`todaySource: 'bundle'` 인 슬라이스**(quote_ratio · fill_strength ·
  // price_level_hits · depth_heatmap)는 반드시 이 계열에서 읽는다 — 캔들 그릇으로 읽으면
  // 에러 없이 조용히 과거분만 얻는다(#719). 축은 `frontend/src/api/rangeSlices.ts` 에
  // 선언돼 있고 `tests/unit/api/test_range_slice_registry_contract.py` 가 그걸 강제한다.
  //
  // 종전 이름은 `hogaBundle` 이었는데 훅이 반환하는 `hogaBundle`(호가 pane 전용, 아래
  // `hogaPaneBundle` prop 으로 들어온다)과 **같은 이름 다른 것**이었다. 실제로 이 값은
  // 호가와 무관한 PriceLevelDotsOverlay 도 쓴다.
  const liveBundle = bundle ?? cb;
  // 호가 pane 전용 그릇 — 훅이 sidecar 착지에 re-key 되지 않도록 따로 memo 한 것이다.
  const paneHogaBundle = hogaPaneBundle ?? liveBundle;
  // 호가비 pane 은 그 위에 전용 폴백이 한 겹 더 있다.
  const paneRatioBundle = ratioBundle ?? paneHogaBundle;
  /** pane 이 받을 그릇 — **스펙의 `bundleKind` 가 정한다**(`chart/RangeSeriesPane.tsx`).
   *
   *  종전엔 이 자리에서 `spec.name` 으로 4갈래 분기했다. 그래서 새 pane 을 추가할 때
   *  이 조건식을 읽고 자기 이름을 어디에 끼울지 판단해야 했다 — 이제 pane 파일 한 칸이다.
   *
   *  `volume` 만 예외다: 누적 체결강도 라인이 켜졌을 때만 라이브가 필요해 **상수로 접히지
   *  않는다**. 그 라인의 데이터 함수도 같은 prefs 키로 게이트되므로(`projectors/volume.ts`)
   *  조건이 둘로 갈리지 않는다. */
  const bundleForPane = (
    spec: { name: string; bundleKind?: PaneBundleKind },
    candlePath: RangeBundle,
  ): RangeBundle =>
    spec.name === 'volume'
      ? (volumeFillStrengthCumulative ? (liveBundle ?? candlePath) : candlePath)
      : spec.bundleKind === 'ratio'
        ? (paneRatioBundle ?? candlePath)
        : spec.bundleKind === 'hoga'
          ? (paneHogaBundle ?? candlePath)
          : spec.bundleKind === 'live'
            ? (liveBundle ?? candlePath)
            : candlePath;
  // 창 간 크로스헤어 동기화가 다리를 놓는 재료. 소비자가 없는 봉(W/M)에서는 빈
  // 배열이라 비용이 없다. `close` 는 크로스헤어 가로선 높이로 쓴다.
  //
  // **`{ts_ms, close}` 로 다시 만들지 않는다.** `Candle` 이 이미 그 두 필드를 가져
  // 구조적으로 `SyncCandle` 이고, 분봉 번들은 틱마다 갱신되므로 map 을 걸면 캔들
  // 수만큼의 할당을 초당 여러 번 하게 된다. 원본을 그대로 넘긴다.
  const syncCandles = useMemo(
    () => (isSyncConsumerTimeframe(timeframe) ? (cb?.candles ?? EMPTY_SYNC_CANDLES) : EMPTY_SYNC_CANDLES),
    [cb, timeframe],
  );
  // 호가 pane 이 빈 **이유**(#1133). prop 을 먼저 보고 번들로 폴백하는 순서가 요점이다 —
  // 번들은 캔들이 없으면 통째로 null 이라, 정작 "왜 비었나" 를 물어야 할 상황에서
  // 사유가 함께 사라진다(자격증명 미설정·벤더 장애). prop 은 그 그릇 밖에 있다.
  const missingDates = hogaMissingDates ?? paneHogaBundle?.missing_dates;
  const hogaMissingText = useMemo(
    () =>
      deriveHogaMissingNotice({
        missingDates,
        venue,
        hasAnyHogaPoints: (paneHogaBundle?.quote_ratio.points.length ?? 0) > 0,
        includeNotCaptured: showNotCapturedNotice,
      }),
    [missingDates, paneHogaBundle?.quote_ratio.points.length, venue, showNotCapturedNotice],
  );
  // 캔들이 없으면 **캔들 결손만** 말한다. 차트 자체가 없는데 "호가 기록 없음" 부터
  // 읽히면 무엇을 고쳐야 할지 알 수 없고, 실제로 고칠 수 있는 쪽은 캔들이다
  // (벤더가 과거를 다시 준다). 호가 결손은 소급 복구가 안 되므로 나중에 말해도 된다.
  const showHogaMissing = !candleEmpty && hogaMissingText;
  // 어느 소스로 그려졌나 — 기본(키움)만이면 침묵한다. 옵션을 없앤 대가로 주는
  // "알 권리" 이고, 완결성 자동 교체를 폐지했기에 특히 필요하다(모듈 주석).
  const sourceBadge = useMemo(() => deriveSourceBadge(cb?.segments), [cb?.segments]);
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

  // 날짜 구분선이 설 자리. **개장 정각이 아니라 그 세션에서 실제로 렌더되는 첫
  // 캔들**의 시각이다 — 이유는 `dayBoundaryTicks` 의 docstring(요약: lwc 의
  // `timeToCoordinate` 는 보간이 아니라 조회라, 첫 캔들이 09:00 이 아닌 날은 축에
  // 그 시각이 없어 선이 조용히 사라졌다). D/W/M 은 한 캔들이 곧 하루라 구분선을
  // 그리지 않으므로(아래 오버레이 마운트 게이트와 같은 조건) 계산도 건너뛴다.
  const nextDayBoundaryTicks = useMemo(
    () =>
      cb && isMinuteTimeframe(timeframe)
        ? resolveDayBoundaryTicks(cb.candles, axis)
        : NO_DAY_BOUNDARY_TICKS,
    [cb, axis, timeframe],
  );
  // 값이 같으면 이전 참조를 유지한다 — SSE 틱이 `cb` 를 갈아 끼워도 오늘 캔들이
  // 붙을 뿐 각 세션의 첫 캔들은 그대로라, 새 배열을 내려보내면 오버레이의 memo 만
  // 헛되이 깨진다. 렌더 중 ref 쓰기는 위 axisRef 와 같은 패턴이고 같은 값이면
  // 아무것도 안 바꾸므로 StrictMode 이중 렌더에서도 멱등이다.
  const dayBoundaryTicksRef = useRef<readonly DayBoundaryTick[]>(NO_DAY_BOUNDARY_TICKS);
  if (!sameDayBoundaryTicks(dayBoundaryTicksRef.current, nextDayBoundaryTicks)) {
    dayBoundaryTicksRef.current = nextDayBoundaryTicks;
  }
  const dayBoundaryTicks = dayBoundaryTicksRef.current;

  // 드로잉 귀속 단위 = (종목, 봉 슬롯). 분봉(1m~30m)은 한 슬롯을 공유하고
  // D/W/M 은 각자 슬롯을 갖는다 — 같은 종목이라도 분봉에 그린 도형이 일봉에
  // 나타나지 않는다. code 가 없으면(종목 미선택) scope 도 없다.
  const drawingScope = useMemo(() => drawingScopeFor(code, timeframe), [code, timeframe]);

  // Drawing-host concerns (paneSeries registry, activeScope binding,
  // panel-anchor computation) live in their own hook so this file stays
  // focused on chart bootstrap, viewport policy, and overlay mounts.
  const { paneSeries, registerPaneSeries, unregisterPaneSeries } =
    useDrawingHost(chart, drawingScope);
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
  // PaneId('candle'·'volume' …)는 창마다 같은 고정 문자열이라 창 스코프가 없으면
  // 차트 창끼리 서로의 레전드를 덮어쓰고 지운다.
  const legendScope = useWindowScopeId();
  const handleLegendReady = useCallback(
    (name: string, entries: { series: ISeriesApi<any>; meta: SeriesLegendMeta }[]) =>
      registerPaneLegend(legendScope, name as PaneId, entries),
    [registerPaneLegend, legendScope],
  );
  const handleLegendGone = useCallback(
    (name: string) => unregisterPaneLegend(legendScope, name as PaneId),
    [unregisterPaneLegend, legendScope],
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
  // 「분봉으로」 목적지 계산이 읽는다 — `readJumpTargetMs` 는 useCallback([]) 이라
  // 렌더 클로저를 볼 수 없다. 렌더 중 쓰기는 위 `lastCandleMsRef` 와 같은 규약.
  const candlesRef = useRef<readonly Candle[]>(EMPTY_CANDLES);
  candlesRef.current = cb?.candles ?? EMPTY_CANDLES;
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
  // 크로스헤어 버스 origin (ADR-0119 PR-D) — 이 차트의 (창 id·그룹·code·봉)을
  // sidebarCursorMs 와 함께 발행해 같은 그룹 데이터 창만 스팟 모드로 전환한다.
  // Provider 밖(/study·단일 뷰)은 windowId/group null. ref 는 effect 에서 갱신 —
  // 호버(발행)는 paint 이후의 사용자 이벤트라 effect 타이밍으로 충분히 신선하고,
  // publish 콜백(useCallback [])이 호출 시점 최신 값을 읽는다.
  const winCtx = useContext(WindowViewContext);
  const winCtxWindowId = winCtx?.windowId ?? null;
  const winCtxGroup = winCtx?.group ?? null;
  const cursorOriginRef = useRef<SidebarCursorOrigin>({
    windowId: winCtxWindowId, group: winCtxGroup, code, timeframe,
  });
  useEffect(() => {
    cursorOriginRef.current = { windowId: winCtxWindowId, group: winCtxGroup, code, timeframe };
  }, [winCtxWindowId, winCtxGroup, code, timeframe]);
  const publishedCursorMsRef = useRef<number | null>(null);
  const publishedBasisDateRef = useRef<string | null>(null);
  const publishedCursorActiveRef = useRef<boolean | null>(null);
  const sidebarCursorTimeoutRef = useRef<number | null>(null);
  const pendingSidebarCursorMsRef = useRef<number | null>(null);
  // Wall-clock time of the last ACTUAL sidebarCursorMs store write. Same-value
  // publishes are skipped and intentionally do NOT refresh this, so wiggling
  // inside one candle bucket can't postpone the next real update.
  const sidebarCursorLastPublishAtRef = useRef<number | null>(null);

  // 창 간 크로스헤어 동기화 발행 — origin 을 실은 **즉시** 채널. 기존 두 채널을
  // 쓰지 못하는 이유는 `useLiveCursorStore` 의 해당 필드 주석 참조.
  //
  // **소비자가 있는 봉만 발행한다**(분봉 · `D`). 슬롯이 하나라 아무나 쓰면 마지막 쓴
  // 사람이 이기는데, 아무도 받지 않는 발행은 표시에 기여하지 않으면서 **유효한 발행만
  // 밀어낸다**. `/live` 실측(2026-08-11): 포인터가 분봉 창에 있는데도 일봉 창이 자기
  // 크로스헤어를 발행해 슬롯을 덮었고, 동기화 표시가 그대로 사라졌다. 그때는 일봉에
  // 소비자가 없어서 그랬고 지금은 있다 — 그래서 술어가 `canPublishSyncCursor` 이고,
  // 그것이 곧 `isSyncConsumerTimeframe` 이다(두 집합을 갈라 놓지 않겠다는 뜻).
  // W/M 은 여전히 소비자가 없어 발행하지 않는다.
  const publishSyncCursor = useCallback((cursorMs: number) => {
    if (!canPublishSyncCursor(cursorOriginRef.current.timeframe)) return;
    useLiveCursorStore.getState().setSyncCursor(cursorMs, cursorOriginRef.current);
  }, []);

  const cancelPendingSidebarCursor = useCallback(() => {
    if (sidebarCursorTimeoutRef.current !== null) {
      window.clearTimeout(sidebarCursorTimeoutRef.current);
      sidebarCursorTimeoutRef.current = null;
    }
    pendingSidebarCursorMsRef.current = null;
  }, []);

  const clearSidebarCursor = useCallback(() => {
    cancelPendingSidebarCursor();
    // 두 채널 모두 **내가 발행한 것만** 지운다. 슬롯은 전역 한 벌인데 차트 창은
    // 여럿이라, 가드 없이 지우면 옆 창의 정리가 호버 중인 창의 스팟을 죽인다
    // (근거·실측은 useLiveCursorStore 의 소유자 절).
    const ownerWindowId = cursorOriginRef.current.windowId;
    useLiveCursorStore.getState().clearSidebarCursorFrom(ownerWindowId);
    // 동기화 커서 해제 경로를 여기 하나로 모은다. 크로스헤어 핸들러의 clear 분기
    // 전부와 언마운트 정리가 이미 이 콜백을 지나므로, 포인터가 차트를 벗어나거나
    // 창이 닫히면 옆 창의 크로스헤어도 같이 꺼진다(안 그러면 화면에 눌어붙는다).
    useLiveCursorStore.getState().clearSyncCursorFrom(ownerWindowId);
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
        useLiveCursorStore.getState().setSidebarCursor(next, cursorOriginRef.current);
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
  // (registered once, reads refs) so callers can snapshot the current view
  // synchronously, before any per-viewKey remount.
  // Written during render (like axisRef) so it's current before any effect.
  const chartRef = useRef<IChartApi | null>(chart);
  chartRef.current = chart;
  const horizontalGridLinesEnabled = useActivePrefs((prefs) => prefs.horizontalGridLinesEnabled);
  const verticalGridLinesEnabled = useActivePrefs((prefs) => prefs.verticalGridLinesEnabled);

  // Viewport capture (ADR-0069 A안): read the live chart's visible range + zoom
  // and pin them to a real-time anchor. The remaining caller is the saved-view
  // write path (`studySaveCommand` via `ChartWindow.captureViewport`) — the tab
  // stores that used to call it on switch-away are gone (ADR-0113, ADR-0149).
  // Stable identity (refs only) so the registration effect runs once.
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
  // 창-스코프 절단(ADR-0119 C2c-2a): historicalFromDate 의 imperative 읽기/확장은
  // 창 런타임(Provider 안) 또는 전역 스토어(밖) — getState 병행 경로의 대응물.
  const historicalRange = useHistoricalRangeActions();
  const viewGuard = useWindowViewGuard();
  const canTriggerBackfill = useCallback(
    // 얼린 창은 백필을 아예 돌리지 않는다 — 근거는 `savedRangeFrozen` prop 도크스트링.
    () => !savedRangeFrozen
      && (lastAppliedCountRef.current !== null || historicalRange.snapshot().historicalFromDate !== null),
    [historicalRange, savedRangeFrozen],
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
  // 사이드카 대기 상한(SIDECAR_REVEAL_CAP_MS)이 소진됐는가. viewKey 단위로 리셋한다 —
  // 이전 뷰의 cap-reached 가 새 뷰의 첫 커밋을 조기 reveal 하면 안 된다.
  const [sidecarCapReached, setSidecarCapReached] = useState(false);
  const sidecarCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (sidecarCapTimerRef.current !== null) {
      clearTimeout(sidecarCapTimerRef.current);
      sidecarCapTimerRef.current = null;
    }
    setSidecarCapReached(false);
  }, [viewKey]);
  // Cancel a pending reveal rAF on unmount so it can't setState after teardown.
  useEffect(() => () => {
    if (revealRafRef.current !== null) cancelAnimationFrame(revealRafRef.current);
    if (calendarViewportRetryRafRef.current !== null) cancelAnimationFrame(calendarViewportRetryRafRef.current);
    if (sidecarCapTimerRef.current !== null) clearTimeout(sidecarCapTimerRef.current);
  }, []);
  // 사이드카 캡 타이머. **캔들·호가가 이미 settle 됐고 사이드카만 남은 시점**에서만
  // 시작한다 — 이 시작점이 설계의 급소다. viewKey 변경 시점부터 세면 캔들 콜드
  // fetch(~1s)가 캡을 먼저 소진해, vdist 의 캔들-후행 체인(+0.2s)조차 매번 캡을
  // 놓치고 **모든 콜드 로드가 따로 뜸**이 된다 — 고치려던 것보다 나쁜 결과다.
  //
  // 타이머는 viewKey 리셋·언마운트에서만 정리하므로(dep churn 에 재시작하지 않는다)
  // 한 창(window)당 정확히 한 번 동작한다. 사이드카가 캡 전에 settle 되면 아래 메인
  // reveal effect 가 즉시 열고(dep 에 isSidecarLoading 포함), 이 타이머는 뒤늦게
  // fire 해도 무해하다(reveal 의 revealedKey === viewKey 가드로 no-op).
  useEffect(() => {
    const waitingOnSidecar = isSidecarLoading && !isPastCandlesLoading && !isHogaLoading;
    if (!waitingOnSidecar || sidecarCapReached || sidecarCapTimerRef.current !== null) return;
    sidecarCapTimerRef.current = setTimeout(() => {
      sidecarCapTimerRef.current = null;
      setSidecarCapReached(true);
    }, SIDECAR_REVEAL_CAP_MS);
  }, [isSidecarLoading, isPastCandlesLoading, isHogaLoading, sidecarCapReached]);

  // Leftward-pan historical backfill + staleness-free viewport repositioning
  // (pre-swap layout snapshot, post-setData reposition, lazy-fetch trigger,
  // settle-loop) live in this headless controller. Called from the parent so
  // its layout snapshot runs before — and its repositioner after —
  // RangeSeriesPane's child setData within the same bundle commit. The
  // repositioner and the initial-view effect below are mutually exclusive via
  // historicalFromDate (null → initial-view owns the viewport; non-null →
  // repositioner), so their relative declaration order is immaterial.
  // ── 기간 점프 ───────────────────────────────────────────────────────────
  // 동기화 토글(`rangeSyncEnabled`)에 묶지 **않는다**. 저것은 "따라다닐 것인가" 를
  // 정하는 스위치이고 점프는 사용자가 누를 때만 한 번 움직이는 명령이라, 끌 이유가
  // 애초에 없다(안 누르면 아무 일도 일어나지 않는다). 종목 축만 크로스헤어와
  // 공유한다 — 세 동기화가 이미 그 토글을 함께 쓴다.
  //
  // ⚠ **백필 호출보다 위에 있어야 한다** — `backfillFromDate` 를 그쪽에 넘긴다.
  const jumpCrossSymbol = useActivePrefs((p) => p.cursorSyncCrossSymbol);
  /**
   * 목적지 = **이 창에서 보이는 가장 오른쪽 캔들**. 규칙은 이것 하나다
   * (2026-08-22 사용자 결정).
   *
   * 한때 「마지막으로 호버한 봉이 화면 안이면 그것」이 앞에 있었다. 걷어낸 이유는
   * 정확도가 아니라 **예측 가능성**이다 — 같은 화면에서 같은 버튼을 눌러도 마우스가
   * 그 사이 어디를 지나갔는지에 따라 목적지가 달라졌고, 그래서 툴팁 미리보기가
   * 편의가 아니라 **필수**였다. 지금은 "일봉 오른쪽 끝 = 분봉 오른쪽 끝" 한 문장으로
   * 설명이 끝난다. 화면 중간의 특정 날짜를 콕 집는 경로는 필요해지면 별도 제스처
   * (일봉 캔들 더블클릭)로 두는 것이 맞다 — 한 컨트롤이 상황에 따라 두 뜻을 갖는
   * 것보다 낫다.
   *
   * `toMs` 를 그대로 쓰지 않고 **그 이하의 마지막 실재 캔들**로 내리는 이유는 저장뷰
   * 앵커와 같다: 우측 여백을 보고 있으면 그 시각의 봉이 없다(그때 목적지는 최신
   * 캔들이 되고, 그것이 「보이는 가장 오른쪽 캔들」의 정의와도 맞는다).
   */
  const readJumpTargetMs = useCallback((): number | null => {
    const c = chartRef.current;
    if (!c) return null;
    // 좌표 읽기만 여기서 한다 — 규칙은 `jumpTargetMs` 가 갖고 차트 없이 테스트된다.
    let vr: { to: unknown } | null = null;
    try {
      vr = c.timeScale().getVisibleRange();
    } catch {
      vr = null;
    }
    const toMs = vr === null ? null : axisRef.current.toReal(Number(vr.to) * 1000);
    return jumpTargetMs(candlesRef.current, toMs);
  }, []);
  useEffect(() => {
    if (!canPublishTimeframeJump(timeframe)) return;
    onJumpSourceReady?.(readJumpTargetMs);
    return () => onJumpSourceReady?.(() => null);
  }, [timeframe, readJumpTargetMs, onJumpSourceReady]);
  const minuteJump = useTimeframeJump({
    chart,
    axis,
    containerRef,
    candles: cb?.candles ?? EMPTY_CANDLES,
    enabled: isTimeframeJumpTarget(timeframe),
    minuteScrollbackFloorDate,
    myWindowId: winCtxWindowId,
    myTimeframe: timeframe,
    myGroup: winCtxGroup,
    myCode: code,
    allowCrossSymbol: jumpCrossSymbol,
  });
  const { state: minuteJumpState, clear: clearMinuteJump } = minuteJump;
  useEffect(() => {
    onMinuteJumpChange?.({ state: minuteJumpState, clear: clearMinuteJump });
  }, [minuteJumpState, clearMinuteJump, onMinuteJumpChange]);

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
    settledFromDate,
    savedRangeFromDate,
    minuteScrollbackFloorDate,
    // 게이트를 통과한 값이다 — 원시 슬롯을 물리면 받지도 않은 점프를 위해 과거를
    // 긁는 창이 생긴다(그 prop 주석의 그 사고).
    jumpFromDate: minuteJump.backfillFromDate,
  });
  // Modifier-aware 휠 줌/팬 — handleScale.mouseWheel: false(아래 createChartEx
  // 옵션)와 한 쌍. 스펙: docs/superpowers/specs/2026-06-07-live-wheel-interactions-design.md
  const getLiveRightOffsetBars = useCallback((visibleBars: number, plotWidth: number) => (
    isMinuteTimeframe(timeframe)
      ? minuteRightOffsetBars(visibleBars, plotWidth)
      : (CHART_TIMESCALE_OPTIONS.rightOffset ?? 0)
  ), [timeframe]);
  useWheelInteractions(chart, containerRef, cb, axis, markViewportUserAdjusted, getLiveRightOffsetBars);

  // 기간 동기화(분봉 창 팬 → 일봉 창이 그 기간을 중앙에). 크로스헤어와 **같은 prop**
  // (`cursorSyncCrosshair`)으로 켠다 — 둘 다 "창 간 동기화" 라는 한 결정이고, 페이지가
  // 그 결정의 소유자라는 이유도 같다(그 prop 주석 참조). 세부 on/off 는 ⚙️ 설정의
  // `rangeSyncEnabled`, 종목 축은 크로스헤어와 공유하는 `cursorSyncCrossSymbol` 이다.
  const rangeSyncEnabled = useActivePrefs((p) => p.rangeSyncEnabled);
  const rangeSyncCrossSymbol = useActivePrefs((p) => p.cursorSyncCrossSymbol);
  const rangeSyncOn = cursorSyncCrosshair && rangeSyncEnabled;
  useRangeSyncPublish({
    chart,
    axis,
    containerRef,
    enabled: rangeSyncOn && canPublishRangeSync(timeframe),
    originRef: cursorOriginRef,
    lastCandleMsRef,
  });
  useRangeSyncFollow({
    chart,
    axis,
    candleCount: cb?.candles.length ?? 0,
    enabled: rangeSyncOn && isRangeSyncFollower(timeframe),
    myWindowId: winCtxWindowId,
    myTimeframe: timeframe,
    myGroup: winCtxGroup,
    myCode: code,
    allowCrossSymbol: rangeSyncCrossSymbol,
  });

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
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange));
    };
  }, [chart, containerRef, markViewportUserAdjusted]);

  /**
   * **분봉 지연 착석** — 저장 구간이 뒤늦게 도착하면 그때 앉힌다.
   *
   * 저장뷰를 분봉에서 열면 그 순간 로드된 캔들은 최근 5거래일뿐이라 몇 달 전 구간이
   * 축에 없다. 그러면 `restoreViewport` 착석이 `rightEdgeMs >= cb.candles[0].ts_ms`
   * 가드에서 실패하고 `lastAppliedCountRef` 가 세팅돼 **재시도가 없다** — 백필이 다
   * 와도 화면은 오늘에 남는다(2026-08-21 실측). 그래서 캔들이 갱신될 때마다 "B 가 축에
   * 들어왔는가" 를 보고, 들어온 **첫 순간에 한 번** 앉힌다.
   *
   * 한 번만 앉히는 것이 계약이다(`seatedRef`) — 매 백필마다 앉히면 사용자가 구간
   * 왼쪽을 보고 있는데 화면이 계속 오른쪽으로 튄다. 키에 `viewKey` 를 섞어 봉·종목·
   * 저장뷰가 바뀌면 다시 앉을 기회를 준다.
   *
   * ⚠ **이동만 한다.** 벽(우측 이탈 차단)은 #1457 에서 의도적으로 제거됐다 — 여기에
   * 스냅백 구독을 다시 붙이지 말 것.
   */
  const savedRangeSeatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chart || savedRangeAnchorMs === null) {
      savedRangeSeatedRef.current = null;
      return;
    }
    const seatKey = `${viewKey}|${savedRangeAnchorMs}`;
    if (savedRangeSeatedRef.current === seatKey) return;
    const candles = cb?.candles ?? [];
    const anchorTs = savedRangeAnchorTs(candles, savedRangeAnchorMs);
    // 아직 축에 없다 — 다음 캔들 갱신에서 다시 본다(백필은 진행 중이다).
    if (anchorTs === null) return;
    const ts = chart.timeScale();
    const anchorIdx = ts.timeToIndex?.(
      realMsToVirtualSeconds(axisRef.current, anchorTs) as Time,
      true,
    );
    if (typeof anchorIdx !== 'number' || !Number.isFinite(anchorIdx)) return;
    const current = ts.getVisibleLogicalRange();
    if (!current) return;
    savedRangeSeatedRef.current = seatKey;
    // 저장 span 을 **그릴 수 있는 크기로 접는다** — 넓은 화면에서 저장한 span 을 좁은
    // 창에 그대로 적용하면 여백만 부풀어 캔들이 화면 밖으로 밀린다
    // (`minuteRestoreGeometry` 의 근거). 저장 뷰포트가 없으면 현재 줌 유지.
    const geom = restoreViewport
      ? minuteRestoreGeometry(
          restoreViewport.barSpan,
          ts.width(),
          chart.options().timeScale.minBarSpacing ?? 0.5,
        )
      : null;
    const span = Math.max(1, Math.round(geom?.barSpan ?? current.to - current.from));
    try {
      // B 가 오른쪽 끝 — 여백을 두지 않는다. 저장 구간 끝은 **과거**라 그 오른쪽에
      // 실제 캔들이 있어서, 여백을 두면 그 폭이 곧 "B 이후" 가 된다(2026-08-21 실측).
      ts.setVisibleLogicalRange({ from: anchorIdx - span, to: anchorIdx });
    } catch {
      /* chart torn down between effect runs */
    }
  }, [chart, savedRangeAnchorMs, cb, viewKey, restoreViewport]);
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
      // reveal로 함께 등장(장면1). **단 사이드카에는 상한이 있다** — 캡이 소진되면
      // 캔들을 먼저 공개한다. 근거·경위는 `SIDECAR_REVEAL_CAP_MS`(요약: 사이드카가
      // 빠르다는 전제가 4.68s~11.7s 실측으로 반박됐다).
      //
      // 호가에는 캡이 없다. 실측이 수십~수백 ms 라 캔들 콜드 옆에서 무시할 수 있고,
      // 호가 pane 은 캔들과 같은 축을 공유해 따로 뜨면 어긋남이 더 크게 읽힌다.
      //
      // isSidecarLoading 의 모든 항은 settle(성공·에러)로 반드시 false 수렴하므로
      // 캡이 없더라도 커버가 고착되지는 않는다(useLiveBundle isSidecarLoading 주석) —
      // 캡은 고착 방지가 아니라 **꼬리 지연 차단**이 목적이다.
      const sidecarBlocking = isSidecarLoading && !sidecarCapReached;
      if (!isHogaLoading && !sidecarBlocking) reveal();
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
        // 저장 span이 현재 차트 폭에서 그릴 수 없는 크기면(넓은 /live 에서 저장 →
        // 좁은 /study 에서 복원) 여백만 저장 span 기준으로 부풀어 캔들을 화면 밖으로
        // 밀어낸다. 그리기 가능한 범위로 접고 여백을 재계산한다(D/W/M의
        // maxLegibleSpan 과 대칭).
        const minuteGeometry = isMinuteTimeframe(timeframe)
          ? minuteRestoreGeometry(
              restoreViewport.barSpan,
              tsR.width(),
              chart.options().timeScale.minBarSpacing ?? 0.5,
            )
          : null;
        const range = computeRestoreRange(
          minuteGeometry
            ? { ...restoreViewport, barSpan: minuteGeometry.barSpan }
            : restoreViewport,
          totalBarsR,
          idx,
          minuteGeometry?.rightOffset,
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
    const historicalFromDate = historicalRange.snapshot().historicalFromDate;
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
        // 코드 엄격 동등: 가드가 `code` prop 과 **같은 workarea 공간**을 돌려주므로
        // (`windowView.ts` 의 `getWorkareaCode`) 이 창의 차트면 항상 일치한다.
        // 한때 "activeCode truthy 일 때만 마운트하니 일치한다"고 적혀 있었는데, 그
        // 전제는 지수 창에서 깨져 있었다 — 어댑터가 맨 코드(`'KOSPI'`)를 돌려줘
        // `'index:KOSPI'` 와 영영 달랐고, 이 복원이 지수에선 한 번도 돌지 않았다.
        // 느슨한 truthy-게이트였다면 다른 마운트의 분봉 배치가 live
        // store를 extend하는 월경이 가능하다.
        const remembered = historicalRange.snapshot().lastMinuteHistoricalFromDate;
        const view = viewGuard();
        if (
          remembered !== null &&
          view.timeframe === timeframe &&
          view.code === code
        ) {
          historicalRange.extend(remembered);
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
  }, [chart, cb, timeframe, venue, isPastCandlesLoading, isHogaLoading, isSidecarLoading, sidecarCapReached, viewKey, revealedKey, restoreViewport, viewportLayoutTick]);

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
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        // CHART_LAYOUT_OPTIONS holds LayoutOptions (fontSize, fontFamily), so it
        // must spread HERE. It used to spread at the chart-options root, where
        // lightweight-charts ignored it — which is why the axis kept the library
        // default font at 12px through the density dial (2026-07-15) and both
        // font migrations. Spread first so the explicit keys below still win.
        ...CHART_LAYOUT_OPTIONS,
        // TradingView 어트리뷰션 로고 숨김. lightweight-charts 는 이 로고를
        // Apache-2.0 NOTICE 링크 의무의 "기본 이행 수단"으로 켜 두므로(기본값
        // true) 끄려면 고지를 다른 곳에서 해야 한다 — 리포 루트 NOTICE 파일이
        // 그 역할이다. 스케일 개념이 아니라서 CHART_LAYOUT_OPTIONS 가 아닌
        // 여기에 둔다.
        attributionLogo: false,
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
      crosshair: chartCrosshairOptions(tokens.accent),
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
          // 연도를 앞에 둔다 — 과거 구간을 스크롤하면 월/일만으로는 어느 해인지
          // 알 수 없다(캘린더 분기는 이미 YYYY 를 달고 있었다).
          return `${d.getUTCFullYear()} ${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        },
      },
      timeScale: {
        ...CHART_TIMESCALE_OPTIONS,
        timeVisible: true,
        secondsVisible: false,
        // 축 경계선 off (2026-07-22 구분선 최소화 C안) — 눈금·라벨은 유지되고
        // 축과 캔버스를 가르는 1px 선만 사라진다.
        borderVisible: false,
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
      rightPriceScale: { borderVisible: false },
      autoSize: true,
    });
    setChartEntry({ chart: c as IChartApi, key: viewKey });
    // autoSize: true already attaches lightweight-charts' own ResizeObserver
    // to the container — an extra manual observer here just produces the
    // "Height and width values ignored because 'autoSize' option is enabled"
    // warning on every resize without affecting layout.
    // Dev-only QA handle for browser-level chart viewport inspection.
    //
    // **`__liveChart` 단수는 마지막 생성 차트만 가리킨다** — 워크스페이스처럼 차트
    // 창이 여럿이면 원하는 창을 읽을 수가 없다. 실제로 창 간 동기화를 `/browse` 로
    // 검증할 때, 소비 창을 읽으려고 봉을 W→D 로 토글해 차트를 **재생성시키는**
    // 편법을 써야 했다(2026-08-21). 그래서 창 id 로 찾는 레지스트리를 함께 둔다.
    //
    // 값은 `IChartApi` 그대로다 — `chartElement()` 로 DOM 까지 도달할 수 있어,
    // QA 스크립트가 좌표 조준(`elementFromPoint`)이나 제목 텍스트 매칭 없이 그 창의
    // 캔버스에 직접 이벤트를 쏠 수 있다. 창이 겹쳐 있어도 안전하다.
    //
    // 키는 창 id, Provider 밖(`/study`·단일 뷰)은 `'global'`. 창 id 는 컴포넌트
    // 수명 동안 불변이라(windowViewContext 의 불변식) effect deps 에 넣지 않는다.
    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __liveChart?: unknown;
        __liveCharts?: Map<string, unknown>;
      };
      w.__liveChart = c;
      (w.__liveCharts ??= new Map()).set(winCtxWindowId ?? 'global', c);
    }

    return () => {
      c.remove();
      setChartEntry(null);
      // 파괴된 차트를 dev 전역이 계속 붙들면 그 인스턴스와 데이터가 window 에서
      // 도달 가능한 채로 남아 힙 스냅샷 조사를 오염시킨다(이 파일의 진단 대상이
      // 바로 힙이라 특히 곤란하다).
      if (import.meta.env.DEV) {
        const w = window as unknown as {
          __liveChart?: unknown;
          __liveCharts?: Map<string, unknown>;
        };
        if (w.__liveChart === c) delete w.__liveChart;
        // 레지스트리도 같이 비운다 — 같은 이유(파괴된 차트가 window 에서 도달
        // 가능하면 힙 스냅샷이 오염된다). 그 사이 같은 키를 새 차트가 가져갔으면
        // 건드리지 않는다(창 재마운트 순서상 실제로 일어난다).
        const key = winCtxWindowId ?? 'global';
        if (w.__liveCharts?.get(key) === c) w.__liveCharts.delete(key);
      }
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

  // 창-스코프 절단 — 필드별 구독으로 전역 폴백의 재렌더 입도 보존.
  const prefMovingAverages = useWindowIndicator((s) => s.movingAverages);
  const prefMovingAverageEnabled = useWindowIndicator((s) => s.movingAverageEnabled);
  const prefMovingAverageHidden = useWindowIndicator((s) => s.movingAverageHidden);
  const prefVolumeEnabled = useWindowIndicator((s) => s.volumeEnabled);
  const prefQuoteTotalsEnabled = useWindowIndicator((s) => s.quoteTotalsEnabled);
  const prefRatioEnabled = useWindowIndicator((s) => s.ratioEnabled);
  const prefFillStrengthEnabled = useWindowIndicator((s) => s.fillStrengthEnabled);
  const prefProgramTradeEnabled = useWindowIndicator((s) => s.programTradeEnabled);
  const prefForeignNetEnabled = useWindowIndicator((s) => s.foreignNetEnabled);
  const prefInstitutionNetEnabled = useWindowIndicator((s) => s.institutionNetEnabled);
  const indicatorPrefs = useMemo(
    () => ({
      movingAverages: prefMovingAverages,
      movingAverageEnabled: prefMovingAverageEnabled,
      movingAverageHidden: prefMovingAverageHidden,
      volumeEnabled: prefVolumeEnabled,
      quoteTotalsEnabled: prefQuoteTotalsEnabled,
      ratioEnabled: prefRatioEnabled,
      fillStrengthEnabled: prefFillStrengthEnabled,
      programTradeEnabled: prefProgramTradeEnabled,
      foreignNetEnabled: prefForeignNetEnabled,
      institutionNetEnabled: prefInstitutionNetEnabled,
    }),
    [prefMovingAverages, prefMovingAverageEnabled, prefMovingAverageHidden,
      prefVolumeEnabled, prefQuoteTotalsEnabled, prefRatioEnabled,
      prefFillStrengthEnabled, prefProgramTradeEnabled, prefForeignNetEnabled,
      prefInstitutionNetEnabled],
  );
  // 사용자 소유 pane 순서(ADR-0114 §3) — paneSpecsForTimeframe 의 3번째 인자로 전달.
  const paneOrder = useWindowPaneOrder();
  // 사용자 소유 Pane 크기 가중치(#703) — separator 드래그 결과의 SSOT.
  const paneStretch = useWindowPaneStretch();
  const setPaneStretch = useIndicatorActions().setPaneStretch;
  // separator 드래그 진행 중 여부 — stretch 재적용 effect 의 가드.
  const paneDragRef = useRef(false);
  // 드래그 종료 시 pane index → PaneId 매핑에 쓰는 최신 spec 목록.
  const paneSpecsRef = useRef<readonly BoundPaneSpec[]>([]);
  const askPeakEnabled = useWindowIndicator((s) => s.askPeakEnabled);
  const bidPeakEnabled = useWindowIndicator((s) => s.bidPeakEnabled);
  const askPeakWallHidden = useWindowIndicator((s) => s.askPeakHidden);
  const bidPeakWallHidden = useWindowIndicator((s) => s.bidPeakHidden);
  const askPeakLabelEnabled = useActivePrefs((s) => s.askPeakLabelEnabled);
  const askPeakRankArrowEnabled = useActivePrefs((s) => s.askPeakRankArrowEnabled);
  const bidPeakRankArrowEnabled = useActivePrefs((s) => s.bidPeakRankArrowEnabled);
  const bidPeakLabelEnabled = useActivePrefs((s) => s.bidPeakLabelEnabled);
  const askPeakIntraMax = useActivePrefs((s) => s.askPeakIntraMax);
  const askPeakVisibleTimeCutoff = useActivePrefs((s) => s.askPeakVisibleTimeCutoff);
  const bidPeakIntraMax = useActivePrefs((s) => s.bidPeakIntraMax);
  const bidPeakVisibleTimeCutoff = useActivePrefs((s) => s.bidPeakVisibleTimeCutoff);
  // 회피 rect 도 선·도킹 라벨과 같은 MA 필터를 타야 한다 — 안 그러면 필터로 사라진
  // 라벨을 피해 고저 극값 라벨이 pane 안쪽으로 밀리는 유령 회피가 남는다.
  const askPeakMaFilter = usePeakMaFilter('ask');
  const bidPeakMaFilter = usePeakMaFilter('bid');
  // 일봉 MA 필터는 **여기 한 곳에서만** 만든다 — 데이터 fetch 가 걸린 훅이라 소비처(선 2 ·
  // 도킹 라벨 · 회피 rect)마다 부르면 쿼리가 그만큼 는다. 같은 참조를 셋에 내려보낸다.
  const peakDailyMaInput = {
    code,
    venue,
    todayKst,
    candles: cb?.candles ?? EMPTY_CANDLES_FOR_DAILY_MA,
    enabled: isMinuteTimeframe(timeframe),
    kisEnabled: dailyCandleKisEnabled,
  };
  const askPeakDailyMaFilter = usePeakDailyMaFilter({ ...peakDailyMaInput, side: 'ask' });
  const bidPeakDailyMaFilter = usePeakDailyMaFilter({ ...peakDailyMaInput, side: 'bid' });
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
      safeUnsubscribe(() => timeScale.unsubscribeVisibleTimeRangeChange(update));
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
  // cutoff 재계산판 최대벽의 유효-스냅샷 하한 — useLiveChartData 의 peakSessionOpenMs 와
  // 같은 정의(선택 venue 의 개장). 두 경로가 갈리면 같은 벽이 cutoff 유무에 따라 다르게
  // 걸러진다.
  const peakSessionOpenMs = useMemo(
    () => liveVenueSessionBoundsMs(todayKst, venue).open_ms,
    [todayKst, venue],
  );
  const askDayPeakSourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (askDayPeakSourceRef.current === null) askDayPeakSourceRef.current = new IncrementalPeakWallSource('ask');
  const bidDayPeakSourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (bidDayPeakSourceRef.current === null) bidDayPeakSourceRef.current = new IncrementalPeakWallSource('bid');
  const renderDayAskPeaks = useMemo(
    () => canRecomputeAskCutoff && isMinuteTimeframe(timeframe)
      ? deriveDayAskPeaksIncrementalAsOf(
        askDayPeakSourceRef.current!,
        liveObSnapshots,
        liveTradeSnapshots,
        historicalAskSeeds,
        todayKst,
        peakSessionOpenMs,
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
      peakSessionOpenMs,
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
        peakSessionOpenMs,
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
      peakSessionOpenMs,
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

  // 게이트를 통과한 pane 목록(= 사용자가 켜 둔 것). 접기 이전 상태다.
  const gatedPaneSpecs = useMemo(
    () => paneSpecsForTimeframe(timeframe, activePaneToggles, paneOrder),
    [timeframe, activePaneToggles, paneOrder],
  );
  // 접기(점진적 degradation) 적용 후 실제로 마운트할 목록. stretch 재적용 effect 와
  // 렌더 JSX 가 **반드시 같은 목록**을 봐야 pane index → PaneId 매핑이 어긋나지 않는다.
  // 접기는 렌더 시점 파생값이며 저장 설정에는 쓰지 않는다(`paneFolding.ts` 참조).
  const [
    { specs: visiblePaneSpecs, foldedCount: foldedPaneCount, timeAxisVisible },
    observePaneFoldTarget,
  ] = usePaneFolding(gatedPaneSpecs, paneStretch);

  // 각 pane 앞에 놓인 pane 이름 시퀀스. `RangeSeriesPane` 의 lifecycle dep 으로 들어가
  // "밑에서 pane 인덱스가 밀리는" pane 들을 재생성에 참여시킨다 — 왜 필요한지는 그
  // prop 의 JSDoc 참조(요약: 빈 pane 은 lwc 가 자동 삭제하고 아래 인덱스가 당겨진다).
  //
  // 앞 시퀀스가 바뀐 pane 은 항상 **연속된 suffix** 를 이룬다: i 번 pane 이 바뀌면
  // i 뒤의 모든 pane 도 자기 앞 시퀀스 안에 그 변화를 포함한다. 그래서 teardown 후
  // 남는 것은 [0..i-1] 이고, effect 가 오름차순으로 돌며 i, i+1, … 로 **append** 한다
  // (최초 마운트와 같은 경로 — 새 순서 가정이 없다).
  const precedingPaneKeys = useMemo(() => {
    const keys: string[] = [];
    let acc = '';
    for (const spec of visiblePaneSpecs) {
      keys.push(acc);
      acc = acc === '' ? spec.name : `${acc}|${spec.name}`;
    }
    return keys;
  }, [visiblePaneSpecs]);

  // 컨테이너 ref 합성 — 접기 관측자는 노드 등장을 봐야 하므로 callback ref 이고
  // (그 훅의 주석 참조), `containerRef` 는 차트 생성·휠·구분선 드래그·폭 측정이
  // 계속 쓴다. `observePaneFoldTarget` 이 `useState` setter 라 참조가 안정적이므로
  // 이 합성 콜백도 안정적이다 — 렌더마다 detach/attach 가 돌지 않는다.
  const setContainer = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    observePaneFoldTarget(el);
  }, [observePaneFoldTarget]);

  // 글랜스 티어 — 보조 pane 이 전부 접히고도 캔들이 좁으면 시간축(28px)까지 숨겨
  // 캔들에 돌려준다. 이 크기에서 28px 는 전체의 20% 가 넘는 사치이고, 절대 시각은
  // 크로스헤어 툴팁이 대신한다. 시간 척도 자체는 그대로라 좌표 변환에 영향이 없다.
  useEffect(() => {
    if (!chart) return;
    chart.applyOptions({ timeScale: { visible: timeAxisVisible } });
  }, [chart, timeAxisVisible]);

  useEffect(() => {
    if (!chart || !cb) return;
    const specs = visiblePaneSpecs;
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
  }, [chart, cb, visiblePaneSpecs, paneStretch]);

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
  // 픽셀 아님). 좌표 변환은 HighLowLabelsPrimitive.draw 가 매 프레임 수행한다:
  // priceToCoordinate 는 가격축 스케일 스냅샷이라, 여기(데이터-deps memo)서 구우면
  // 오토스케일·팬/줌·pane 토글로 축이 리스케일돼도 재계산되지 않아 회피 rect 가 실제
  // 칩 위치와 어긋난다. 게이트는 도킹 라벨이 **실제로 그려지는** 조건과 동일해야 한다
  // (LivePeakWallDockedLabels 미러: enabled && !hidden && labelEnabled) — 안 그려지는
  // 라벨을 피해 극값 라벨이 pane 안쪽으로 밀리던 유령 회피의 수정. 가시범위/rank 컷은
  // 렌더 단 2D 교차 검사가 흡수한다(화면 밖 칩 rect 는 극값 라벨과 교차하지 않음).
  // 회피 입력의 **공유 원천**. 게이트는 「지표가 켜져 있고 눈으로 숨기지 않음」까지만
  // 두고, 라벨/화살표의 개별 토글은 아래 두 memo 가 각자 건다 — 그래야 세그먼트 계산이
  // 표면 수만큼 늘지 않는다(이 파일은 이미 오버레이와 별개의 두 번째 계산 사본이다).
  const avoidAskWallSegments = useMemo(() => (
    cb && isMinuteTimeframe(timeframe) && askPeakEnabled && !askPeakWallHidden
      ? buildPeakWallOverlaySegments({
        peaks: renderDayAskPeaks,
        segments: cb.segments,
        candles: cb.candles,
        axis,
        todayKst,
        baselineStyle: HIGH_LOW_AVOID_BASELINE_STYLE,
        intraMax: askPeakIntraMax,
        visibleTimeCutoff: askVisibleTimeCutoffForRender,
        maFilter: askPeakMaFilter,
        dailyMaFilter: askPeakDailyMaFilter,
      })
      : EMPTY_AVOID_SEGMENTS
  ), [
    askPeakDailyMaFilter,
    askPeakEnabled,
    askPeakIntraMax,
    askPeakMaFilter,
    askPeakWallHidden,
    askVisibleTimeCutoffForRender,
    axis,
    cb,
    renderDayAskPeaks,
    timeframe,
    todayKst,
  ]);

  const avoidBidWallSegments = useMemo(() => (
    cb && isMinuteTimeframe(timeframe) && bidPeakEnabled && !bidPeakWallHidden
      ? buildPeakWallOverlaySegments({
        peaks: renderDayBidPeaks,
        segments: cb.segments,
        candles: cb.candles,
        axis,
        todayKst,
        baselineStyle: HIGH_LOW_AVOID_BASELINE_STYLE,
        intraMax: bidPeakIntraMax,
        visibleTimeCutoff: bidVisibleTimeCutoffForRender,
        maFilter: bidPeakMaFilter,
        dailyMaFilter: bidPeakDailyMaFilter,
      })
      : EMPTY_AVOID_SEGMENTS
  ), [
    axis,
    bidPeakDailyMaFilter,
    bidPeakEnabled,
    bidPeakIntraMax,
    bidPeakMaFilter,
    bidPeakWallHidden,
    bidVisibleTimeCutoffForRender,
    cb,
    renderDayBidPeaks,
    timeframe,
    todayKst,
  ]);

  const highLowAvoidWallLabels = useMemo(() => {
    const wallSegments: (PeakWallSegment & { side: PeakWallLabelSide })[] = [
      ...(askPeakLabelEnabled
        ? avoidAskWallSegments.map((segment) => ({ ...segment, side: 'ask' as const }))
        : []),
      ...(bidPeakLabelEnabled
        ? avoidBidWallSegments.map((segment) => ({ ...segment, side: 'bid' as const }))
        : []),
    ];
    // livePeakWallDockedLabelsFromSegments 미러: 라벨 없는 세그먼트 제외 + **(측면, 그날, 가격)**
    // 별 최대 qty 1개. 라벨이 발생 분봉 위로 옮겨간 뒤로는 같은 가격이라도 날마다 x 앵커가
    // 달라 칩이 따로 그려지므로, 가격만으로 합치면 실재하는 칩을 회피 대상에서 놓친다.
    const best = new Map<string, (typeof wallSegments)[number]>();
    for (const segment of wallSegments) {
      if (segment.label === '' || !Number.isFinite(segment.price)) continue;
      const key = `${segment.side}|${segment.time0 as unknown as number}|${segment.price}`;
      const prev = best.get(key);
      if (!prev || segment.qty > prev.qty) best.set(key, segment);
    }
    return [...best.values()].map((s) => ({
      price: s.price,
      time0: s.time0,
      time1: s.time1,
      peakTime: s.peakTime,
      side: s.side,
      label: s.label,
    }));
  }, [askPeakLabelEnabled, avoidAskWallSegments, avoidBidWallSegments, bidPeakLabelEnabled]);

  // 순위 화살표 회피 입력 — 라벨과 달리 **중복 제거를 하지 않는다**. 화살표는 그날·가격이
  // 아니라 **순위**로 잘리므로, 상위 3개는 primitive 가 draw 프레임의 보이는 범위로 고른다.
  const highLowAvoidRankArrows = useMemo(() => {
    if (!cb) return EMPTY_AVOID_ARROWS;
    const extremes = candleExtremesByVirtualSec(cb.candles, axis);
    return [
      ...(askPeakRankArrowEnabled
        ? peakWallRankArrowsFromSegments(avoidAskWallSegments, 'ask', extremes)
        : []),
      ...(bidPeakRankArrowEnabled
        ? peakWallRankArrowsFromSegments(avoidBidWallSegments, 'bid', extremes)
        : []),
    ];
  }, [
    askPeakRankArrowEnabled,
    avoidAskWallSegments,
    avoidBidWallSegments,
    axis,
    bidPeakRankArrowEnabled,
    cb,
  ]);

  const publishCursorHover = useCallback(
    (virtualTime: unknown, pointX?: number, fromUserPointer = false): void => {
      if (!chart) return;
      const store = useLiveCursorStore.getState();
      // **옆 창의 호버가 sync 로 그려 준 크로스헤어는 발행하지 않는다.**
      //
      // `CursorSyncCrosshair` 가 이 차트에 `setCrosshairPosition` 을 걸면 그 뒤의
      // 데이터 갱신마다 lwc 가 crosshairMove 를 **재발화**한다(호출 시점에는 안
      // 쏜다 — 그 파일 주석이 잰 것이 그 시점 하나뿐이라 루프가 없다고 결론냈다).
      // 그 이벤트로 발행하면 **옆 창의 유효한 발행을 내 origin 으로 덮어쓴다**.
      //
      // 2026-08-12 실측(003490 장중, 분봉+일봉 두 창): 스토어가 두 창 사이에서
      // 초당 여러 번 핑퐁했다 — 25초에 분봉 97회 / 일봉 96회, `null` 은 **0회**.
      // 덮어쓴 origin 의 봉이 `D` 라 `resolveCursorDetailScope` 가 inactive 로
      // 떨어뜨려 10호가·거래원이 **함께** latest 를 그렸다(사용자 신고 증상).
      //
      // 소유자 가드(clear 쪽)로는 이걸 못 막는다 — 지우는 게 아니라 **쓰는** 경로다.
      // 실제 포인터 이벤트는 통과시킨다: 사용자가 이 창으로 마우스를 옮기면 그때는
      // 이 창이 발행자가 되는 게 맞다.
      if (!fromUserPointer) {
        const syncOrigin = store.syncCursorOrigin;
        if (syncOrigin !== null && syncOrigin.windowId !== cursorOriginRef.current.windowId) {
          return;
        }
      }
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
          // 값이 같아도 다시 발행한다. 그 사이 옆 창이 발행했다가 해제하면, 이 창의
          // "이미 발행함" 기억(publishedCursorMsRef) 때문에 동기화 표시가 영영
          // 돌아오지 않는다.
          publishSyncCursor(cursorMs);
          return;
        }
        publishedCursorMsRef.current = cursorMs;
        store.setCursor(cursorMs);
        scheduleSidebarCursor(cursorMs);
        publishSyncCursor(cursorMs);
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
    [axis, chart, clearSidebarCursor, onCandleBasisHover, onCursorActiveChange, publishSyncCursor, scheduleSidebarCursor],
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
        // 드로잉 오버레이의 실제 pointer 이벤트에서 온다 → 사용자 입력.
        publishCursorHover(chart.timeScale().coordinateToTime(latest.x), latest.x, true);
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
      useLiveCursorStore.getState().resetCursorFrom(cursorOriginRef.current.windowId);
      // resetCursorFrom 이 남의 발행분을 만나 no-op 이어도 **내 sync 발행은 반드시
      // 걷는다** — 이유는 아래 cleanup 의 같은 줄 주석 참조.
      useLiveCursorStore.getState().clearSyncCursorFrom(cursorOriginRef.current.windowId);
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
          // 이 분기는 `param.sourceEvent.localX` 가 있어야 진입한다 → 사용자 입력.
          publishCursorHover(t, separatorX, true);
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
      // rAF 밖에서 뽑는다 — lwc 가 param 객체를 재사용하면 프레임이 도는 사이 값이
      // 바뀔 수 있다(`point` 를 여기서 잡아 두는 것과 같은 이유).
      const hasSourceEvent = param.sourceEvent != null;
      pending = requestAnimationFrame(() => {
        pending = null;
        const t = typeof param.time === 'number'
          ? param.time
          : (readNumericCrosshairTimeFromSeriesData(param.seriesData)
            ?? chart.timeScale().coordinateToTime(point.x));
        // sourceEvent 가 있으면 내 마우스가 만든 이벤트다. 없으면 데이터 갱신에
        // 따른 재발화이고, 그때는 sync 소비 중인 창이 발행하지 못하게 막힌다.
        publishCursorHover(t, point.x, hasSourceEvent);
      });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      safeUnsubscribe(() => chart.unsubscribeCrosshairMove(handler));
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
      // **내가 발행자일 때만** 지운다. 이 cleanup 은 언마운트뿐 아니라 deps 변경
      // (특히 `axis` 재생성)마다 도는데, 가드가 없으면 옆 창의 재구독 한 번이
      // 호버 중인 창의 스팟을 통째로 날린다 — 그것이 10호가 창이 틱마다 최신
      // 호가로 튀던 기전이다(실측은 useLiveCursorStore 의 소유자 절).
      useLiveCursorStore.getState().resetCursorFrom(cursorOriginRef.current.windowId);
      // sync 는 **따로** 걷는다. 위가 no-op 인 경우가 정확히 위험한 순간이기
      // 때문이다: 포인터가 이 창을 떠나 leave 타이머(120ms)가 걸린 사이 옆 창이
      // sidebar 를 발행하면 주인이 바뀌고, 그 안에 이 창이 언마운트되면 타이머는
      // 취소되는데 내가 띄운 sync 크로스헤어만 남아 옆 창에 눌어붙는다. 이 호출은
      // 자체 소유자 가드가 있어 남의 것은 건드리지 않는다.
      useLiveCursorStore.getState().clearSyncCursorFrom(cursorOriginRef.current.windowId);
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
      safeUnsubscribe(() => chart.unsubscribeClick(handler));
    };
  }, [chart, axis, onCandleBasisClick]);

  const showTradeVolumePocOverlay = shouldShowTradeVolumePocOverlay(
    timeframe,
    forceHogaPanes,
    tradeVolumePocs.length,
  );
  const depthHeatmapPoints = useMemo(() => depthHeatmapFromWire(depthHeatmap), [depthHeatmap]);
  const depthHeatmapEnabledStore = useWindowIndicator((s) => s.depthHeatmapEnabled);
  const showDepthHeatmapOverlay = shouldShowDepthHeatmapOverlay(
    timeframe,
    depthHeatmapEnabledStore,
    depthHeatmapPoints.length,
  );
  // enabled 만 여기서 구독한다 — hidden/색/불투명도는 오버레이 내부에서 읽어야
  // 그 변경이 LiveChartRoot 전체를 재렌더하지 않는다(리프 격리).
  const depthDeltaEnabledStore = useWindowIndicator((s) => s.depthDeltaEnabled);
  const showDepthDeltaOverlay = shouldShowDepthDeltaOverlay(
    timeframe,
    depthDeltaEnabledStore,
    depthDeltaToday.length,
  );

  return (
    <div
      data-testid="live-chart-root"
      onContextMenu={(event) => event.preventDefault()}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div
        ref={setContainer}
        className="live-chart-canvas"
        style={{ width: '100%', height: '100%', background: 'var(--bg-card)' }}
      />
      {/* 접힌 지표 알림 — 설정이 꺼진 것으로 오해하지 않도록. 차트 마운트 여부와
          무관하게 접힘이 있으면 띄운다. */}
      <FoldedPaneNotice count={foldedPaneCount} timeAxisVisible={timeAxisVisible} />
      {/* 호가 pane 이 빈 이유 — 같은 모서리에 쌓는다(둘 다 "덜 보여주고 있다" 는 말). */}
      <HogaMissingNotice
        text={showHogaMissing ? hogaMissingText : null}
        timeAxisVisible={timeAxisVisible}
        stacked={foldedPaneCount > 0}
        // 뒷문장이 사유마다 갈린다 — 기본값은 호가 pane 전용이라 업스트림 결손엔 틀린다.
        ariaLabel={showHogaMissing
          ? `${hogaMissingText}. ${deriveHogaMissingDetail(missingDates)}`
          : undefined}
      />
      {/* 캔들이 아예 없을 때 — 빈 중앙을 쓴다(가릴 것이 없다). 행동 버튼이 있어야 해서
          호가 안내와 달리 포인터를 받는다(버튼만; 컨테이너는 통과시킨다). */}
      <CandleEmptyState state={candleEmpty ?? null} onRetry={onRetryCandles} />
      {/* 소스 배지 — 같은 모서리 스택. 캔들이 없으면 말할 소스도 없다. */}
      {!candleEmpty && (
        <HogaMissingNotice
          text={sourceBadge}
          timeAxisVisible={timeAxisVisible}
          stacked={foldedPaneCount > 0 || !!showHogaMissing}
          testId="source-badge"
          // 배지가 소스만 내던 시절엔 "…데이터로 그려졌습니다" 가 맞았는데, 이제 결손
          // 크기도 실린다("키움 WS · 결손 5시간 31분"). 문장에 끼우면 어색해지므로
          // 레이블은 상태를 가리키는 형태로 둔다.
          ariaLabel={`이 차트의 데이터 상태: ${sourceBadge}`}
        />
      )}
      {chart && cb && axis.segments.length > 0 && (
        <>
          {candleAlwaysOnTop && (
            <>
              <MovingAverageOverlay chart={chart} bundle={cb} axis={axis} />
              <DailyMovingAverageOverlay chart={chart} bundle={cb} axis={axis} code={code} timeframe={timeframe} venue={venue} todayKst={todayKst} dailyCandleKisEnabled={dailyCandleKisEnabled} override={dailyMovingAverageOverride} />
            </>
          )}
          {visiblePaneSpecs.map((spec, i) => (
            <RangeSeriesPane
              key={spec.name}
              chart={chart}
              bundle={bundleForPane(spec, cb)}
              axis={axis}
              paneIndex={i}
              precedingPaneKey={precedingPaneKeys[i]}
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
            <QuoteLevelLines paneSeries={paneSeries} bundle={paneRatioBundle ?? cb} axis={axis} />
          )}
          {isMinuteTimeframe(timeframe) && (
            <LiveWallSurgeMarkers
              paneSeries={paneSeries}
              events={cb.wall_surge ?? EMPTY_WALL_SURGE}
              candles={cb.candles}
              axis={axis}
            />
          )}
          {isMinuteTimeframe(timeframe) && (
            <LiveAskPeakSegments
              paneSeries={paneSeries}
              axis={axis}
              dayAskPeaks={renderDayAskPeaks}
              segments={cb.segments}
              candles={cb.candles}
              todayKst={todayKst}
              visibleTimeCutoff={askVisibleTimeCutoffForRender}
              dailyMaFilter={askPeakDailyMaFilter}
            />
          )}
          {isMinuteTimeframe(timeframe) && (
            <LiveBidPeakSegments
              paneSeries={paneSeries}
              axis={axis}
              dayBidPeaks={renderDayBidPeaks}
              segments={cb.segments}
              candles={cb.candles}
              todayKst={todayKst}
              visibleTimeCutoff={bidVisibleTimeCutoffForRender}
              dailyMaFilter={bidPeakDailyMaFilter}
            />
          )}
          {isMinuteTimeframe(timeframe) && (
            <LivePeakWallDockedLabels
              paneSeries={paneSeries}
              axis={axis}
              dayAskPeaks={renderDayAskPeaks}
              dayBidPeaks={renderDayBidPeaks}
              segments={cb.segments}
              candles={cb.candles}
              todayKst={todayKst}
              askVisibleTimeCutoff={askVisibleTimeCutoffForRender}
              bidVisibleTimeCutoff={bidVisibleTimeCutoffForRender}
              askDailyMaFilter={askPeakDailyMaFilter}
              bidDailyMaFilter={bidPeakDailyMaFilter}
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
          {showDepthDeltaOverlay && (
            <DepthDeltaOverlay
              chart={chart}
              paneSeries={paneSeries}
              axis={axis}
              points={depthDeltaToday}
            />
          )}
          <DrawingOverlay
            chart={chart}
            axis={axis}
            scope={drawingScope}
            paneSeries={paneSeries}
            onChartHoverPassthrough={handleDrawingOverlayHover}
            bucketMs={drawingBarMsFor(timeframe, cb?.bucket_ms ?? undefined)}
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
            visibleSpecs={visiblePaneSpecs}
            dataEpoch={cb}
            hasDepthDelta={depthDeltaToday.length > 0}
            candles={cb?.candles}
            axis={axis}
            code={code}
          />
          <CandleTooltip chart={chart} bundle={cb} quoteBundle={paneRatioBundle} axis={axis} paneSeries={paneSeries} timeframe={timeframe} />
          {/* 고저 극값 라벨 — 보이는 범위의 최고/최저봉에 극값 대비율 라벨. DOM 없는
              primitive 호스트라 팬/줌 재계산은 lwc 캔버스 패스가 담당한다(캔들과 같은
              프레임). SSE 틱엔 미재렌더(cb 안정), 토글 self-gate. */}
          <HighLowLabelsHost
            chart={chart}
            bundle={cb}
            axis={axis}
            paneSeries={paneSeries}
            timeframe={timeframe}
            avoidWallLabels={highLowAvoidWallLabels}
            avoidRankArrows={highLowAvoidRankArrows}
            avoidRankArrowLimit={PEAK_WALL_LEGEND_RANK_LIMIT}
          />
          {isMinuteTimeframe(timeframe) && liveBundle && (
            <PriceLevelDotsOverlay chart={chart} bundle={liveBundle} axis={axis} paneSeries={paneSeries} />
          )}
          <DrawingPropertyPanel scope={drawingScope} />
          {/* Day boundary lines only make sense on intraday timeframes —
              D/W/M's candles are already day/week/month units, so a
              per-day vertical line collapses onto each candle. */}
          {isMinuteTimeframe(timeframe) && (
            <DayBoundaryOverlay chart={chart} boundaries={dayBoundaryTicks} />
          )}
          {/* `/study` 저장 구간 밴드 — 캘린더 봉 전용. 분봉에선 저장 구간이 곧
              화면 전체라 표시할 것이 없고, 좌표계도 다르다(캘린더 축 = 하루 1포인트).
              DOM 없는 primitive 호스트라 팬/줌 재계산은 lwc 캔버스 패스가 담당한다
              (캔들과 같은 프레임 — 고저 극값 라벨과 동일 처방). */}
          {savedRangeBand && !isMinuteTimeframe(timeframe) && (
            <StudySavedRangeBandHost axis={axis} paneSeries={paneSeries} marks={savedRangeBand} />
          )}
          {/* 창 간 크로스헤어 동기화(옆 창 호버 → 이 창). 게이트가 둘이다:
              **분봉 · `D` 만** — 소비자가 자기 축으로 스냅할 다리가 있는 봉이다(바로 위
              동시호가 음영이 그 스냅을 안 해서 좌표계가 어긋나 삭제됐다). W/M 은 한
              캔들이 여러 날을 담아 범위 밖이다. 방향 넷(분봉→일봉·일봉→일봉·
              분봉→분봉·일봉→분봉)의 규칙은 `cursorSync.ts` 헤더가 갖는다.
              **`cursorSyncCrosshair` 로 켠다** — 그 prop 주석 참조. */}
          {cursorSyncCrosshair && isSyncConsumerTimeframe(timeframe) && (
            <CursorSyncCrosshair
              chart={chart}
              axis={axis}
              candles={syncCandles}
              timeframe={timeframe}
              paneSeries={paneSeries}
              code={code}
            />
          )}
          {/* 동시호가(15:20–15:30 KST) 배경 음영은 2026-08-09 에 삭제했다
              (사용자 결정). `auctionWindowMask` 토글은 그대로 살아 있고 —
              라벨이 "동시호가 구간 지표 숨김" 이라 계약도 변하지 않는다 —
              데이터 마스킹(RatioPane / QuoteTotalsPane / FillStrength,
              그리고 DataWindow 가 maskRatio 로 내려보내는 BookPanel 총잔량)은
              각 projector 가 계속 소유한다. 음영만 없어졌다.

              삭제 사유는 취향이 아니라 버그였다: 밴드 좌표를 intraday
              VirtualAxis 의 가상시각으로 계산하는데 D/W/M 차트의 timeScale 은
              일/주/월 포인트로 인덱싱돼 있어 **좌표계가 다르다**. 그래서
              일봉에서 10분 창이 ~1700px 로 부풀고, 거래일 수만큼(수백 개)
              겹친 10% 알파가 포화해 캔버스(z-index:1) 뒤(z-0)에서 우측
              거터·시간축 아래로 새어 나왔다. 되살릴 일이 있으면 좌표계부터
              맞추고 `isMinuteTimeframe` 게이트를 함께 달 것. */}
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
      {/* 호가·사이드카 홀드 노트: 캔들은 도착했지만 지표 경로 settle을 기다리며 reveal이
          홀드된 동안 표시. 침묵 커버가 "행"처럼 보이는 걸 막는다. !chartReady 가드로 ungated
          팬 경로에서 revealed 차트 위 플래시를 막는다. 커버 div 뒤에 렌더돼 커버 위에 페인트된다.

          ⚠ **술어는 위 `revealWhenSettled` 의 홀드 조건과 같은 집합이어야 한다.**
          종전엔 홀드가 `!isHogaLoading && !isSidecarLoading` 인데 이 문구는 `isHogaLoading`
          만 봤다 — 그 차집합(`isHogaLoading=false, isSidecarLoading=true`)이 **커버는 떠
          있는데 글자가 하나도 없는** 구간이었다. 실측으로 사이드카가 호가보다 훨씬 느리다
          (콜드 5거래일 창에서 호가 44ms vs 사이드카 4.68s, 한 달 창은 11.7s) → 종목 첫
          방문마다 수 초짜리 단색 사각형이 뜬다.

          캡(`SIDECAR_REVEAL_CAP_MS`, 2026-08-19 복원)이 생긴 뒤에도 이 술어는 그대로
          성립한다 — 캡이 발화하면 `chartReady` 가 true 가 되고 `!chartReady` 가드가
          문구를 걷어 간다. 즉 문구가 뜨는 구간은 이제 **최대 700ms** 로 유계다.

          경위: 문구 자체가 #457 에서 **침묵 커버를 막으려고** 생겼는데, 이후 #479·#579 가
          홀드 게이트만 넓히고 문구를 안 데려갔다(그 불일치를 뒤에 맞췄다). #579 가 없앤
          캡은 위 상수의 근거대로 되살렸다 — 이 문구는 그 캡 이전·이후 모두 정확하므로
          새 시각 요소를 만들지 않는다. */}
      {cb !== null && cb.candles.length > 0 && !chartReady && (isHogaLoading || isSidecarLoading) && (
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
          하단-좌측이라 한 flex 컬럼으로 묶어 겹침을 막는다(드물게 동시 발생).

          ⚠ **바깥 게이트에 안쪽 칩의 조건이 전부 들어 있어야 한다.** 안쪽에만 칩을
          추가하면 컨테이너가 안 떠서 조용히 사라진다(2026-08-22 실측으로 밟았다). */}
      {(clampEngaged || (cb !== null && cb.candles.length > 0 && warnSummary.count > 0)) && (
        <div
          style={{
            position: 'absolute', bottom: 'var(--space-md)', left: 'var(--space-md)',
            display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)',
            pointerEvents: 'none', zIndex: 31,
          }}
        >
          {/* 캔들은 있는데 일부 과거구간이 rate-limit 등으로 누락 → 비차단 안내.
              title 에 벤더 원문을 실어 원인을 손 닿는 곳에 둔다 — 칩 문구만으로는
              'rate-limit 인가 아닌가' 밖에 알 수 없다. pointerEvents 는 이 스택의
              컨테이너에서 none 이라 칩만 auto 로 되살려야 hover 가 산다. */}
          {cb !== null && cb.candles.length > 0 && warnSummary.count > 0 && (
            <div
              data-testid="partial-load-chip"
              title={warnSummary.firstMsg ?? undefined}
              style={{
                ...chipStyle,
                ...(warnSummary.firstMsg ? { pointerEvents: 'auto' as const } : null),
              }}
            >
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
