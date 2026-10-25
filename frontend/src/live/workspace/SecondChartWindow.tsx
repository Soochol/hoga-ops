/** Seconds keep their observed-trade source and paging; chart tools, series,
 * overlays and pane layout are shared with minute charts. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSecondHistory, SECOND_INITIAL_BARS, SECOND_HISTORY_PAGE_LIMIT } from '../../api/secondHistory';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useWorkspaceStore, groupTargetChartWindow, type WorkspaceWindow, type GroupSymbol } from '../../state/workspace';
import { bucketSeconds, useLivePageStore, type SavedRangeFocus, type SecondTimeframe } from '../../state/livePage';
import { TimeframeControl } from '../TimeframeControl';
import { useEffectiveVenue } from '../useEffectiveVenue';
import { useWindowIndicators } from './windowView';
import { publishGroupChartLink, clearGroupChartLink } from './groupChartLinkSource';
import { useMinuteClock } from '../useMinuteClock';
import { realMsToYyyymmdd } from '../liveDateTime';
import { useTradeBrowseStore } from '../tradeBrowse';
import { LiveChartRoot } from '../LiveChartRoot';
import { ChartDrawingShell } from '../ChartDrawingShell';
import ChartErrorBoundary from '../../chart/ChartErrorBoundary';
import { RegularSessionAction } from './RegularSessionAction';
import { ChartAnalysisActions } from './ChartAnalysisActions';
import { useChartHeaderFold } from './useChartHeaderCompact';
import { ViewedDateChip } from './ViewedDateChip';
import { secondChartBundle } from './secondChartBundle';
import { secondRangeQuery } from './secondChartNavigation';
import { savedRangeAppliesTo, SAVED_RANGE_VENUE } from '../../studyViews/savedRangeFocus';
import { SavedRangeChip } from './SavedRangeChip';
import { studySavedRangeMarks } from '../../studyViews/studyDailyContext';
import { LiveStudyViewSaveButton } from '../../studyViews/LiveStudyViewSaveButton';
import type { LiveStudySaveSource } from '../../studyViews/studySaveCommand';
import type { TabViewport } from '../viewportAnchor';
import { registerSecondTimeframeViewport, restoreSecondTimeframeViewport } from './secondTimeframeViewport';

const SECOND_PANES = { hogaPanes: false, foreignNet: false, institutionNet: false };
type Props = { win: WorkspaceWindow; symbol: GroupSymbol | null; timeframe: SecondTimeframe };
export function SecondChartWindow({ win, symbol, timeframe }: Props) {
  const selectedVenue = useLiveVenueStore(s => s.venue);
  const code = symbol?.kind === 'index' || symbol?.kind === 'us_stock' ? null : symbol?.code ?? null;
  const effectiveVenue = useEffectiveVenue(code, selectedVenue);
  const focus = useLivePageStore(s => s.savedRangeFocus);
  const navigation = useWorkspaceStore(s => s.chartRuntime[win.id]?.secondRange);
  const matchingFocus = savedRangeAppliesTo(focus, code, timeframe) ? focus : null;
  // Explicit drill-down overrides the saved span, while retaining its KRX source.
  const saved = navigation ? null : matchingFocus;
  const venue = matchingFocus ? SAVED_RANGE_VENUE : effectiveVenue;
  const today = realMsToYyyymmdd(useMinuteClock());
  return <SecondChartContent key={`${code}|${venue}|${today}|${timeframe}|${saved?.viewId ?? ""}|${navigation?.seq ?? ''}`} win={win} symbol={symbol}
    timeframe={timeframe} code={code} venue={venue} today={today} saved={saved} />;
}

function SecondChartContent({ win, symbol, timeframe, code, venue, today, saved }: Props & {
  code: string | null; venue: ReturnType<typeof useEffectiveVenue>; today: string; saved: SavedRangeFocus | null;
}) {
  const indicators = useWindowIndicators();
  const savedRangeRequestSeq = useLivePageStore(s => s.savedRangeRequestSeq);
  const target = useWorkspaceStore(s => groupTargetChartWindow(s.windows, s.zOrder, win.group)?.id === win.id);
  const regularSessionOnly = win.chart?.regularSessionOnly ?? false;
  const seconds = bucketSeconds(timeframe) as 1 | 5 | 10 | 30;
  const [incoming] = useState(() => useWorkspaceStore.getState().chartRuntime[win.id]?.secondViewport);
  const [transfer, setTransfer] = useState(() => incoming?.target === timeframe && incoming.code === code && incoming.venue === venue ? incoming : null);
  useEffect(() => { if (incoming) useWorkspaceStore.getState().consumeSecondViewport(win.id, incoming); }, [win.id, incoming]);
  const navigation = useWorkspaceStore(s => s.chartRuntime[win.id]?.secondRange);
  const focusedRange = saved ?? navigation;
  const pastTransfer = transfer && !transfer.followLatest;
  const requested = focusedRange ? secondRangeQuery(focusedRange, seconds) : pastTransfer
    ? { ...secondRangeQuery({ fromMs: transfer.viewport.rightEdgeMs, toMs: transfer.viewport.rightEdgeMs }, seconds), fromMs: undefined } : null;
  const requiredFromMs = requested?.fromMs ?? (transfer?.viewport.leftEdgeMs === undefined ? undefined
    : Math.floor(transfer.viewport.leftEdgeMs / (seconds * 1000)) * seconds * 1000);
  const date = requested?.date ?? today;
  const query = useSecondHistory(code, venue, date, seconds, regularSessionOnly, {
    endMs: requested?.endMs, fromMs: requested?.fromMs, live: !focusedRange && !pastTransfer,
    includePrices: indicators.fillStrengthEnabled || indicators.indicatorInstances?.some(row => row.category === 'fill-strength' && !row.hidden),
  });
  const { bars, hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const loadOlder = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) return fetchNextPage({ cancelRefetch: false });
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const needsOlder = requiredFromMs !== undefined ? query.oldestLoadedMs != null && query.oldestLoadedMs > requiredFromMs : bars.length < SECOND_INITIAL_BARS;
  const initialPending = needsOlder && (hasNextPage || query.catalogPending);
  useEffect(() => { if (needsOlder && !query.isError) loadOlder(); }, [needsOlder, loadOlder, query.isError]);
  const bundle = useMemo(() => code ? secondChartBundle(code, date, seconds, bars, query.prices) : null, [code, date, seconds, bars, query.prices]);
  const [browseLoadError, setBrowseLoadError] = useState(false);
  const browseActive = useTradeBrowseStore(s => s.session?.origin.windowId === win.id);
  useEffect(() => { if (!browseActive) setBrowseLoadError(false); }, [browseActive]);
  const onNeedTradeBrowseCandle = useCallback((cursorMs: number) => {
    setBrowseLoadError(false);
    void query.loadAt(cursorMs).catch(() => setBrowseLoadError(true));
  }, [query.loadAt]);
  const captureViewport = useRef<() => TabViewport | null>(() => null);
  const onCaptureReady = useCallback((capture: () => TabViewport | null) => { captureViewport.current = capture; }, []);
  useEffect(() => registerSecondTimeframeViewport(win.id, () => {
    const viewport = initialPending || query.isPending ? null : captureViewport.current();
    // The last candle in a bounded historical query is not the live edge.
    return viewport && code ? { code, timeframe, venue, viewport,
      followLatest: viewport.atLiveEdge && !focusedRange && !pastTransfer } : transfer;
  }), [win.id, code, timeframe, venue, initialPending, query.isPending, transfer, focusedRange, pastTransfer]);
  const restoreViewport = useMemo((): TabViewport | null => {
    if (initialPending || !bundle?.candles.length) return null;
    if (transfer) return restoreSecondTimeframeViewport(transfer, bundle.candles);
    if (!focusedRange) return null;
    return { rightEdgeMs: Math.min(focusedRange.toMs, bundle.candles.at(-1)!.ts_ms),
      barSpan: saved?.savedTimeframe === timeframe ? saved.savedBarSpan : Math.max(1, bundle.candles.length - 1), atLiveEdge: false };
  }, [transfer, focusedRange, initialPending, bundle, saved, timeframe]);
  const source = useMemo((): LiveStudySaveSource | null => code && venue === SAVED_RANGE_VENUE && !initialPending && !query.isPending && bundle?.candles.length
    ? { origin: 'live', code, label: symbol?.name ?? code, timeframe, bundle, captureViewport: () => captureViewport.current() } : null,
  [code, venue, initialPending, query.isPending, bundle, symbol?.name, timeframe]);
  const savedMarks = useMemo(() => saved && bundle ? studySavedRangeMarks({ from_ms: saved.fromMs, to_ms: saved.toMs }, bundle.candles) : null, [saved, bundle]);
  const returnToLive = () => {
    setTransfer(null);
    if (saved) useLivePageStore.getState().clearSavedRange();
    useWorkspaceStore.getState().setSecondChartRange(win.id, null);
  };
  const viewportRef = useRef<HTMLDivElement>(null);
  const [headerFold, headerRef] = useChartHeaderFold();
  const [viewedDate, setViewedDate] = useState<{ date: string | null; returnToLive: () => void }>({ date: null, returnToLive: () => {} });
  const pagedHistory = useMemo(() => ({ hasMore: hasNextPage || query.catalogPending, loading: query.isFetching || query.catalogPending,
    blocked: initialPending || query.isPending || query.isError || query.catalogError, fillViewport: true, loadOlder }),
  [hasNextPage, query.catalogPending, query.catalogError, query.isFetching, query.isPending, initialPending, query.isError, loadOlder]);

  useEffect(() => {
    if (!target) return;
    publishGroupChartLink({ windowId: win.id, group: win.group, code, timeframe, bundle: null,
      adjustFactors: undefined, todayKst: today, secondDate: date,
      vdist: { rangeCount: indicators.volumeDistributionRangeCount, color: indicators.volumeDistributionColor, regularSessionOnly,
        maxColor: indicators.volumeDistributionMaxColor, hoverCutoffEnabled: indicators.volumeDistributionHoverCutoffEnabled } });
    return () => clearGroupChartLink(win.group, win.id);
  }, [target, win.id, win.group, code, today, date, timeframe, regularSessionOnly, indicators.volumeDistributionRangeCount,
    indicators.volumeDistributionColor, indicators.volumeDistributionMaxColor, indicators.volumeDistributionHoverCutoffEnabled]);

  return <div className="h-full flex flex-col" data-testid="second-chart" data-bar-count={bars.length} data-day-count={bundle?.segments.length ?? 0}>
    <div ref={headerRef} data-testid="chart-window-header" data-compact="" data-compact-timeframe={headerFold.compactTimeframe ? '' : undefined}
      className="live-chart-toolbar flex flex-wrap shrink-0 items-center overflow-hidden bg-bg-card">
      <TimeframeControl timeframe={timeframe} rememberedMinute={win.chart?.lastMinuteTimeframe ?? '1m'}
        onChange={tf => useWorkspaceStore.getState().setChartTimeframe(win.id, tf)}
        secondsEnabled={symbol?.kind !== 'index' && symbol?.kind !== 'us_stock'} compact={headerFold.compactTimeframe} />
      {saved && <SavedRangeChip label={saved.label} fromDate={saved.fromDate} toDate={saved.toDate} krxPinned notice={null} onClear={returnToLive} />}
      {!saved && navigation && <span className="live-chart-state-chip text-xs text-fg-dim" role="status">
        초봉 구간 {query.isError ? '조회 실패' : query.isPending || initialPending ? '불러오는 중' : bars.length ? '표시 중' : '관측 데이터 없음'}
        <button type="button" aria-label="초봉 구간 해제" onClick={returnToLive}>×</button>
      </span>}
      {!focusedRange && (viewedDate.date || pastTransfer) && <ViewedDateChip date={viewedDate.date ?? date}
        onReturn={transfer ? () => setTransfer(null) : viewedDate.returnToLive} />}
      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1">
        <span aria-hidden className="live-chart-toolbar-divider" />
        <ChartAnalysisActions win={win} code={code} timeframe={timeframe} viewportRef={viewportRef} available={bars.length > 0} />
        <LiveStudyViewSaveButton source={source} showLabel={false}
          disabledReason={venue !== SAVED_RANGE_VENUE ? '저장 학습뷰는 KRX 기준입니다. KRX 초봉에서 저장하세요.' : undefined} />
        <RegularSessionAction win={win} showLabel={false} />
      </div>
    </div>
    <div className="relative min-h-0 flex-1">
      <ChartErrorBoundary><ChartDrawingShell>
        <LiveChartRoot key={transfer ? 'transferred' : 'normal'} viewIdentity={saved ? `saved:${saved.viewId}:${savedRangeRequestSeq}` : navigation ? `seconds-range:${navigation.seq}` : undefined}
          onNeedTradeBrowseCandle={!focusedRange ? onNeedTradeBrowseCandle : undefined} regularSessionOnly={regularSessionOnly}
          restoreViewport={restoreViewport} savedRangeBand={savedMarks} savedRangeFrozen={saved != null}
          onViewportCaptureReady={onCaptureReady} code={code} timeframe={timeframe} venue={venue} bundle={bundle} imageViewportRef={viewportRef}
          hoverLinked={win.chart?.hoverLinked ?? true} indicatorLegendsVisible={win.chart?.indicatorLegendsVisible ?? true}
          todayKst={today} clampEngaged={false} captureFloorEngaged={false} isPastCandlesLoading={query.isPending}
          isInitialMinuteHistoryPending={initialPending} historyBackfillEnabled={false} pagedHistory={pagedHistory}
          paneTogglesOverride={SECOND_PANES} dailyCandleKisEnabled={false} onViewedDateChange={setViewedDate} />
      </ChartDrawingShell></ChartErrorBoundary>
      {(!bars.length || !code) && <div className="absolute inset-0 flex items-center justify-center text-fg-dim bg-bg-card/80">
        {!code ? '주식 종목을 선택해주세요' : query.isError ? '초봉을 불러오지 못했습니다' : query.isPending || initialPending ? '초봉 불러오는 중' : '선택한 날짜에 저장된 초봉이 없습니다'}
      </div>}
    </div>
    {browseLoadError && <div role="alert" className="shrink-0 text-xs text-fg-dim">체결 탐색 초봉 조회 실패 · 다른 봉으로 이동하면 재시도합니다</div>}
    {hasNextPage && <button type="button" className="shrink-0 text-xs text-fg-dim hover:text-fg" disabled={isFetchingNextPage}
      onClick={loadOlder}>{isFetchingNextPage ? '이전 구간 불러오는 중' : '이전 구간 불러오기'}</button>}
    <div className="shrink-0 px-2 py-1 text-fg-dim text-xs" role="status">
      {query.isError && <button type="button" onClick={() => { void (query.isFetchNextPageError ? loadOlder() : query.refetch()); }}>초봉 조회 실패 · 다시 조회</button>}
      {query.catalogError && <button type="button" onClick={() => { void query.refetchCatalog(); }}>과거 날짜 조회 실패 · 다시 조회</button>}
      {!query.isPending && !query.isError && !query.catalogError && !hasNextPage && !query.catalogPending && <span>
        {(query.data?.pages.length ?? 0) >= SECOND_HISTORY_PAGE_LIMIT ? '조회 한도 · 최대 64페이지 · '
          : requested?.fromMs !== undefined && query.oldestLoadedMs != null && query.oldestLoadedMs <= requested.fromMs
            ? '선택 구간 시작 · ' : '저장된 과거 데이터 끝 · '}
      </span>}
      {query.storageError ? '저장 오류 · 일부 체결이 누락될 수 있습니다' : query.source === 'hogaplay' ? '과거 체결 원본 기준 · 미수집 구간은 포함되지 않습니다' : '수집된 체결 기준 · 미수집 구간은 포함되지 않습니다'}
    </div>
  </div>;
}
