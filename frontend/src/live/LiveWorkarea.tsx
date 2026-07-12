import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { isMinuteTimeframe, useLivePageStore } from '../state/livePage';
import { useEntryDragStore } from '../state/entryDrag';
import { LiveChartRoot } from './LiveChartRoot';
import { LiveEmptyState } from './LiveEmptyState';
import { IndexSectorRankingPane } from './IndexSectorRankingPane';
import { LiveSidebar } from './LiveSidebar';
import { LiveToolbar } from './LiveToolbar';
import { ChartDrawingShell } from './ChartDrawingShell';
import ChartErrorBoundary from '../chart/ChartErrorBoundary';
import type { LiveInstrument } from './liveInstrument';
import type { AskPeak, BidPeak, RangeBundle } from '../api/types';
import type { LiveSeriesData, LiveTodayAskPeak, LiveTodayBidPeak } from '../api/liveSeries';
import { useIndexSectorRankings } from '../api/indexSectorRankings';
import type { LiveDataWarning } from './liveDataWarnings';
import { useJumpToLive } from './useJumpToLive';
import {
  initialIndexSectorRankingUiState,
  reduceIndexSectorRankingState,
  resolveBasisDate,
} from './indexSectorRankingState';
import type { TabViewport } from './viewportAnchor';
import type { LiveVenueOption } from '../state/liveVenue';
import { realMsToYyyymmdd } from './liveDateTime';
import type { TradeVolumePoc } from './tradeVolumePoc';
import {
  clampRightPanelWidth,
  LIVE_WORKAREA_SPLITTER_WIDTH_PX,
  useLiveLayoutStore,
} from '../state/liveLayout';

/** 관심종목 행을 차트로 드래그할 때 워크에어리어 위에 뜨는 드롭 타깃 오버레이.
 *  드래그 고스트는 패널 overflow 경계에서 잘리므로 워크에어리어 자체를 어포던스로 쓴다.
 *  pointer-events:none — 좌표 hit-test는 rect로 하므로 포인터를 가로채면 안 된다.
 *  색·섀도·모션은 DESIGN.md 토큰 준수: 선택 틴트(--tint-selection, accent 12%) +
 *  accent 점선 보더 + 오버레이 섀도(--shadow-overlay) + short 트랜지션(150ms). */
function ChartDropOverlay({ over }: { over: boolean }) {
  return (
    <div
      aria-hidden
      className="absolute inset-0 flex items-center justify-center"
      style={{
        zIndex: 5,
        pointerEvents: 'none',
        background: over ? 'var(--tint-selection)' : 'transparent',
        border: '2px dashed var(--accent)',
        opacity: over ? 1 : 0.7,
        transition: 'opacity 150ms ease, background 150ms ease',
      }}
    >
      <span
        className="font-ui text-sm font-semibold rounded-md"
        style={{
          padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--accent)',
          color: 'var(--accent-fg)',
          boxShadow: 'var(--shadow-overlay)',
          transform: over ? 'scale(1)' : 'scale(0.97)',
          transition: 'transform 150ms ease',
        }}
      >
        여기에 놓아 종목 변경
      </span>
    </div>
  );
}

interface Props {
  activeCode: string | null;
  /** The Live Candle Backfill bundle, owned by LivePage. ADR-0040 — single
   * useLiveBundle call site per page. Full bundle (chart + live hoga overlay). */
  bundle: RangeBundle | null;
  /** Chart side only, stable across SSE ticks (2026-06-09 bundle-split). Threaded
   * to LiveChartRoot for the candle path. Optional → LiveChartRoot falls back to
   * `bundle`. */
  chartBundle?: RangeBundle | null;
  hogaBundle?: RangeBundle | null;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
  /** useLiveBundle.isHogaLoading — 호가 경로 초기 fetch pending. LiveChartRoot의 reveal
   *  커버가 캔들+호가 pane 동시 등장에 쓴다. 옵셔널 + 기본 false. */
  isHogaLoading?: boolean;
  /** useLiveBundle.isSidecarLoading — 사이드카 경로 초기 fetch pending. LiveChartRoot의
   *  reveal 커버가 캔들+사이드카 지표 동시 등장에 쓴다(개선안 1-A). 옵셔널 + 기본 false. */
  isSidecarLoading?: boolean;
  /** useLiveBundle.isExtending — 진행 루프 settle-effect 구동용. LiveChartRoot로 전달. */
  isExtending: boolean;
  /** Coverage-gap 백필(A안) — 활성 range 지표 커버리지 from_date. LiveChartRoot로 전달.
   * 인덱스(range 지표 없음)는 LivePage가 null로 넘긴다. 옵셔널+기본 null. */
  indicatorCoverageFromDate?: string | null;
  /** 지금 range가 요청 중인 창의 from — coverage 스텝 base의 null-fallback. LiveChartRoot로 전달. */
  rangeWindowFromDate?: string | null;
  /** 활성 경로 과거 fetch 경고(rate-limit 등). LiveChartRoot의 빈칸 문구·부분로딩 칩용. */
  pastDataWarnings?: LiveDataWarning[];
  /** 활성 탭의 저장된 viewport(ADR-0069 A안). cold 전환 복귀 시 보던 위치 복원용으로
   * LiveChartRoot에 전달. */
  restoreViewport?: TabViewport | null;
  /** Distinguishes multiple tabs that point at the same code/timeframe. */
  viewIdentity?: string | null;
  /** Selected KIS candle venue; controls minute-chart initial viewport policy. */
  venue?: LiveVenueOption;
  activeInstrument?: LiveInstrument | null;
  /** Owned by LivePage's single useLiveSeries call. Threaded to LiveSidebar
   * so the LATEST mode reads the same SSE buffer that feeds useLiveBundle. */
  live: LiveSeriesData;
  /** LivePage의 useDayAskPeaks 결과(거래일별) — LiveChartRoot → LiveAskPeakSegments로 전달. */
  dayAskPeaks?: readonly AskPeak[];
  /** Backend today all-price ask peak — optional because tests/legacy callers may omit it. */
  todayAllPriceAskPeak?: AskPeak | null;
  /** Raw backend today ask-peak payload for cutoff-aware live recomputation. */
  todayAskPeakInput?: LiveTodayAskPeak | null;
  /** LivePage의 useDayBidPeaks 결과(거래일별) — LiveChartRoot → LiveBidPeakSegments로 전달. */
  dayBidPeaks?: readonly BidPeak[];
  /** Backend today all-price bid peak — optional because tests/legacy callers may omit it. */
  todayAllPriceBidPeak?: BidPeak | null;
  /** Raw backend today bid-peak payload for cutoff-aware live recomputation. */
  todayBidPeakInput?: LiveTodayBidPeak | null;
  /** 오늘(KST YYYYMMDD) — 오늘 세그먼트만 라이브 엣지까지 연장. */
  todayKst?: string;
  /** Per-day regular-session trade-volume POC bands. */
  tradeVolumePocs?: readonly TradeVolumePoc[];
  paneTogglesOverride?: {
    hogaPanes?: boolean;
  };
  onOpenIndicators?: () => void;
  onOpenSettings?: () => void;
  onOpenSearch?: () => void;
  studySaveControl?: ReactNode;
  /** LivePage save flows keep this callback and invoke it at save time. */
  onViewportCaptureReady?: (capture: () => TabViewport | null) => void;
}

/** 안정 빈 배열 — 기본값이 매 렌더 새 []를 만들지 않게. */
const EMPTY_ASK_PEAKS: readonly AskPeak[] = [];
const EMPTY_BID_PEAKS: readonly BidPeak[] = [];

export function LiveWorkarea({
  activeCode,
  bundle,
  chartBundle,
  hogaBundle,
  clampEngaged,
  isPastCandlesLoading,
  isHogaLoading,
  isSidecarLoading,
  isExtending,
  indicatorCoverageFromDate = null,
  rangeWindowFromDate = null,
  pastDataWarnings,
  restoreViewport,
  viewIdentity,
  venue = 'KRX',
  live,
  dayAskPeaks = EMPTY_ASK_PEAKS,
  todayAllPriceAskPeak = null,
  todayAskPeakInput = null,
  dayBidPeaks = EMPTY_BID_PEAKS,
  todayAllPriceBidPeak = null,
  todayBidPeakInput = null,
  todayKst = '',
  tradeVolumePocs = [],
  paneTogglesOverride,
  onOpenIndicators,
  onOpenSettings,
  onOpenSearch,
  studySaveControl,
  onViewportCaptureReady,
  activeInstrument = null,
}: Props) {
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  // 관심종목 행을 차트로 드래그 중일 때만 드롭 오버레이를 띄운다(WatchlistDrawer가 갱신).
  const draggingEntry = useEntryDragStore((s) => s.draggingCode != null);
  const overChart = useEntryDragStore((s) => s.overChart);

  // 차트 드롭-타깃 seam: 워크에어리어가 자신의 히트테스트를 entryDrag에 등록한다(unmount 해제).
  // 패널 드롭 로직은 이 술어로만 "차트 위인가"를 묻고 차트 DOM·rect를 모른다. 등록/해제
  // 라이프사이클이 "워크에어리어 하나" invariant를 포섭한다(마지막 등록이 진실).
  const workareaRef = useRef<HTMLDivElement>(null);
  const chartPanelRef = useRef<HTMLDivElement>(null);
  const detailPanelScrollRef = useRef<HTMLDivElement>(null);
  const registerChartTarget = useEntryDragStore((s) => s.registerChartTarget);
  const clearChartTarget = useEntryDragStore((s) => s.clearChartTarget);
  const rightPanelWidthPx = useLiveLayoutStore((s) => s.rightPanelWidthPx);
  const setRightPanelWidthPx = useLiveLayoutStore((s) => s.setRightPanelWidthPx);
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);
  const [workareaWidthPx, setWorkareaWidthPx] = useState<number | null>(null);
  useEffect(() => {
    const hitTest = (clientX: number, clientY: number): boolean => {
      const el = chartPanelRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    };
    registerChartTarget(hitTest);
    return () => clearChartTarget(hitTest);
  }, [registerChartTarget, clearChartTarget]);
  const syncWorkareaWidth = useCallback((nextWorkareaWidthPx: number) => {
    if (!(nextWorkareaWidthPx > 0)) return;
    setWorkareaWidthPx(nextWorkareaWidthPx);
  }, []);
  useLayoutEffect(() => {
    const workarea = workareaRef.current;
    if (!workarea) return;
    syncWorkareaWidth(workarea.clientWidth);
  }, [syncWorkareaWidth]);
  useEffect(() => {
    const workarea = workareaRef.current;
    if (!workarea || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      syncWorkareaWidth(entry.contentRect.width);
    });

    observer.observe(workarea);
    return () => observer.disconnect();
  }, [syncWorkareaWidth]);
  useEffect(() => () => {
    activeResizeCleanupRef.current?.();
    activeResizeCleanupRef.current = null;
  }, []);

  const [rankingState, rankingDispatch] = useReducer(
    reduceIndexSectorRankingState,
    initialIndexSectorRankingUiState,
  );
  const openStock = useJumpToLive();
  const isIndexInstrument = activeInstrument?.kind === 'index';
  const rankingAllowed = isIndexInstrument && (isMinuteTimeframe(timeframe) || timeframe === 'D');
  const rankingCandles = (chartBundle ?? bundle)?.candles ?? [];
  const latestRankingDate = rankingCandles.length > 0
    ? realMsToYyyymmdd(rankingCandles[rankingCandles.length - 1].ts_ms)
    : null;
  const rankingBasis = resolveBasisDate(rankingState, latestRankingDate);
  const rankingQuery = useIndexSectorRankings(rankingBasis.date, rankingAllowed, todayKst || null);
  const handleCandleBasisHover = useCallback(
    (date: string | null) => {
      rankingDispatch({ type: 'hover_date', date });
    },
    [rankingDispatch],
  );
  const handleCandleBasisClick = useCallback(
    (date: string | null) => {
      rankingDispatch({ type: 'select_date', date });
    },
    [rankingDispatch],
  );
  useEffect(() => {
    if (!rankingAllowed) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      rankingDispatch({ type: 'clear_date_pin' });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [rankingAllowed]);
  const handleOpenStock = useMemo(
    () => (code: string, name: string) => openStock(code, name),
    [openStock],
  );
  const beginWidthResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const workarea = workareaRef.current;
    if (!workarea) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const startX = event.clientX;
    const workareaWidth = workarea.clientWidth;
    const startWidth = clampRightPanelWidth(
      useLiveLayoutStore.getState().rightPanelWidthPx,
      workareaWidth,
      LIVE_WORKAREA_SPLITTER_WIDTH_PX,
    );
    const target = event.currentTarget;
    const move = (moveEvent: PointerEvent) => {
      const next = clampRightPanelWidth(
        startWidth - (moveEvent.clientX - startX),
        workareaWidth,
        LIVE_WORKAREA_SPLITTER_WIDTH_PX,
      );
      useLiveLayoutStore.setState({ rightPanelWidthPx: next });
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      activeResizeCleanupRef.current = null;
    };
    const finish = (pointerId: number) => {
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      cleanup();
      setRightPanelWidthPx(useLiveLayoutStore.getState().rightPanelWidthPx);
    };
    const up = (upEvent: PointerEvent) => {
      finish(upEvent.pointerId);
    };
    const cancel = (cancelEvent: PointerEvent) => {
      finish(cancelEvent.pointerId);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    activeResizeCleanupRef.current = cleanup;
  }, [setRightPanelWidthPx]);
  const chartPanelStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg-card)',
    boxShadow: 'var(--shadow-panel)',
  };
  const detailPanelVisible = !isIndexInstrument;
  const renderedRightPanelWidthPx = workareaWidthPx != null
    ? clampRightPanelWidth(
      rightPanelWidthPx,
      workareaWidthPx,
      detailPanelVisible ? LIVE_WORKAREA_SPLITTER_WIDTH_PX : 0,
    )
    : rightPanelWidthPx;
  const handleWheelCapture = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.altKey || !detailPanelVisible) return;
    const scroller = detailPanelScrollRef.current;
    if (!scroller) return;
    scroller.scrollTop += event.deltaY;
    event.preventDefault();
  }, [detailPanelVisible]);

  // position:relative는 absolute 오버레이의 containing block. minHeight:0 + overflow:hidden은
  // 차트 캔버스 intrinsic 크기가 flex 높이를 밀어내는 runaway 루프를 막는다(67c527a).
  return (
    <div
      ref={workareaRef}
      data-testid="live-workarea"
      className="flex h-full gap-1 p-1"
      onWheelCapture={handleWheelCapture}
      style={{
        position: 'relative',
        background: 'var(--bg)',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {!activeCode ? (
        <div
          ref={chartPanelRef}
          data-testid="live-chart-panel"
          style={chartPanelStyle}
        >
          <LiveEmptyState cause="no_active_code" onOpenSearch={onOpenSearch} />
        </div>
      ) : (
        <>
          <div
            ref={chartPanelRef}
            data-testid="live-chart-panel"
            style={chartPanelStyle}
          >
            {onOpenIndicators && onOpenSettings && (
              <LiveToolbar
                onOpenIndicators={onOpenIndicators}
                onOpenSettings={onOpenSettings}
                studySaveControl={studySaveControl}
              />
            )}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              {/* lightweight-charts는 내부 불변식 위반 시 React render/effect 안에서
                  동기 throw한다(2026-07-08 venue=UN 콜드 로드 간헐 크래시). 경계 없이는
                  루트까지 버블해 앱 전체가 언마운트(검은 화면)되므로 차트 트리를 격리한다. */}
              <ChartErrorBoundary>
                <ChartDrawingShell>
                  <LiveChartRoot
                    code={activeCode}
                    timeframe={timeframe}
                    venue={venue}
                    bundle={bundle}
                    chartBundle={chartBundle}
                    hogaPaneBundle={hogaBundle}
                    clampEngaged={clampEngaged}
                    isPastCandlesLoading={isPastCandlesLoading}
                    isHogaLoading={isHogaLoading}
                    isSidecarLoading={isSidecarLoading}
                    isExtending={isExtending}
                    indicatorCoverageFromDate={indicatorCoverageFromDate}
                    rangeWindowFromDate={rangeWindowFromDate}
                    pastDataWarnings={pastDataWarnings}
                    restoreViewport={restoreViewport}
                    viewIdentity={viewIdentity ?? undefined}
                    dayAskPeaks={dayAskPeaks}
                    todayAllPriceAskPeak={todayAllPriceAskPeak}
                    todayAskPeakInput={todayAskPeakInput}
                    dayBidPeaks={dayBidPeaks}
                    todayAllPriceBidPeak={todayAllPriceBidPeak}
                    todayBidPeakInput={todayBidPeakInput}
                    liveObSnapshots={live.ob}
                    liveTradeSnapshots={live.trade}
                    todayKst={todayKst}
                    tradeVolumePocs={tradeVolumePocs}
                    depthHeatmap={(chartBundle ?? bundle)?.depth_heatmap}
                    paneTogglesOverride={paneTogglesOverride}
                    onViewportCaptureReady={onViewportCaptureReady}
                    onCandleBasisHover={rankingAllowed ? handleCandleBasisHover : undefined}
                    onCandleBasisClick={rankingAllowed ? handleCandleBasisClick : undefined}
                  />
                </ChartDrawingShell>
              </ChartErrorBoundary>
            </div>
            {rankingAllowed && (
              <IndexSectorRankingPane
                basisDate={rankingBasis.date}
                basisMode={rankingBasis.mode}
                ranking={rankingQuery.data}
                isLoading={rankingQuery.isLoading}
                error={rankingQuery.error}
                onClearDatePin={() => rankingDispatch({ type: 'clear_date_pin' })}
                onOpenStock={handleOpenStock}
              />
            )}
          </div>
          {detailPanelVisible && (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="차트 / 상세 패널 크기 조절"
                data-testid="live-workarea-splitter"
                onPointerDown={beginWidthResize}
                style={{
                  width: LIVE_WORKAREA_SPLITTER_WIDTH_PX,
                  cursor: 'col-resize',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <div aria-hidden style={{ width: 1, height: '100%', background: 'var(--border-strong)', opacity: 0.75 }} />
              </div>
              <div
                role="complementary"
                aria-label="Live Detail Panel"
                ref={detailPanelScrollRef}
                style={{
                  width: renderedRightPanelWidthPx,
                  flexShrink: 0,
                  minHeight: 0,
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--bg-card)',
                  boxShadow: 'var(--shadow-panel)',
                  scrollbarGutter: 'stable',
                }}
              >
                <LiveSidebar
                  code={activeCode}
                  live={live}
                  bundle={chartBundle ?? bundle}
                  todayKst={todayKst}
                  programTrade={(chartBundle ?? bundle)?.program_trade ?? null}
                />
              </div>
            </>
          )}
        </>
      )}
      {draggingEntry && <ChartDropOverlay over={overChart} />}
    </div>
  );
}
