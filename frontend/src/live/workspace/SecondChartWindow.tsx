/** First seconds rollout: observed second candles, volume and a 20-bar MA.
 * A separate pipeline prevents minute vendor requests and slower indicator
 * interpolation from silently pretending to be second-resolution data.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, HistogramSeries, LineSeries, createChart, type IChartApi, type ISeriesApi, type SeriesType, type AutoscaleInfoProvider, type Time } from 'lightweight-charts';
import { useSecondHistory, SECOND_INITIAL_BARS } from '../../api/secondHistory';
import { createVirtualAxis, type VirtualAxis } from '../../util/virtualAxis';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useWorkspaceStore, type WorkspaceWindow, type GroupSymbol } from '../../state/workspace';
import { RegularSessionAction } from './RegularSessionAction';
import { CursorLinkAction } from './CursorLinkAction';
import { TimeframeControl } from '../TimeframeControl';
import { useEffectiveVenue } from '../useEffectiveVenue';
import { useWindowIndicators } from './windowView';
import { publishGroupChartLink, clearGroupChartLink } from './groupChartLinkSource';
import { groupTargetChartWindow } from '../../state/workspace';
import { useLiveCursorStore, sameSidebarCursorOrigin } from '../useLiveCursorStore';
import { useTradeBrowseStore } from '../tradeBrowse';
import { releaseSyntheticCrosshair } from '../../chart/syntheticCrosshair';
import { TradeBrowseCrosshair } from '../../chart/TradeBrowseCrosshair';
import { createSidebarCursorThrottle } from '../sidebarCursorRateLimit';
import { createSecondChartSeriesWriter } from './secondChartSeriesWriter';
import type { LiveVenueOption } from '../../state/liveVenue';
import { useMinuteClock } from '../useMinuteClock';
import { realMsToYyyymmdd } from '../liveDateTime';
import { useThemeChangeRerender } from '../../state/themePrefs';
import { currentThemeKey } from '../../util/tokens';
import { bucketSeconds, type SecondTimeframe } from '../../state/livePage';
import { CHART_LAYOUT_OPTIONS } from '../../util/chartScale';
import { captureSecondViewport, restoreSecondViewport, type SecondChartViewport } from './secondChartViewport';
import { createPersistentCrosshairChart } from '../../chart/persistentCrosshair';
import { useActivePrefs } from '../../state/chartPrefs';
import CandleTooltip from '../CandleTooltip';
import type { PaneSeriesMap } from '../../chart/drawing/chartCoordinates';
import type { PaneId } from '../../chart/drawing/types';

const kstTimeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const kstTime = (value: number) => kstTimeFormatter.format(value * 1000);
const isoDate = (date: string) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

type Props = { win: WorkspaceWindow; symbol: GroupSymbol | null; timeframe: SecondTimeframe };
export function SecondChartWindow({ win, symbol, timeframe }: Props) {
  useThemeChangeRerender();
  const selectedVenue = useLiveVenueStore(s => s.venue);
  const code = (symbol?.kind === 'index' || symbol?.kind === 'us_stock') ? null : symbol?.code ?? null;
  const venue = useEffectiveVenue(code, selectedVenue);
  const today = realMsToYyyymmdd(useMinuteClock());
  const date = today;
  return <SecondChartContent key={`${code}|${venue}|${date}|${timeframe}|${currentThemeKey()}`} win={win} symbol={symbol}
    code={code} venue={venue} date={date} timeframe={timeframe} today={today} />;
}

function SecondChartContent({ win, symbol, code, venue, date, timeframe, today }: Props & {
  code: string | null; venue: LiveVenueOption; date: string; today: string;
}) {
  const indicators = useWindowIndicators();
  const target = useWorkspaceStore(s => groupTargetChartWindow(s.windows, s.zOrder, win.group)?.id === win.id);
  const midnight = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00+09:00`).getTime();
  const seconds = bucketSeconds(timeframe) as 1 | 5 | 10 | 30;
  const regularSessionOnly = win.chart?.regularSessionOnly ?? false;
  const regularSessionOnlyRef = useRef(regularSessionOnly);
  regularSessionOnlyRef.current = regularSessionOnly;
  const horizontalGrid = useActivePrefs(p => p.horizontalGridLinesEnabled);
  const verticalGrid = useActivePrefs(p => p.verticalGridLinesEnabled);
  const candleOnlyScale = useActivePrefs(p => p.candlePaneCandleOnlyScale);
  const candlesOnTop = useActivePrefs(p => p.candleAlwaysOnTop);
  const tooltipEnabled = useActivePrefs(p => p.candleTooltipEnabled);
  const gridRef = useRef({ horizontalGrid, verticalGrid });
  gridRef.current = { horizontalGrid, verticalGrid };
  const [tooltipChart, setTooltipChart] = useState<{ chart: IChartApi; paneSeries: PaneSeriesMap } | null>(null);
  const query = useSecondHistory(code, venue, date, seconds, regularSessionOnly);
  const [browseLoadError, setBrowseLoadError] = useState(false);
  const browseActive = useTradeBrowseStore(s => s.session?.origin.windowId === win.id);
  useEffect(() => { if (!browseActive) setBrowseLoadError(false); }, [browseActive]);
  const bars = query.bars;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const axis = useMemo(() => {
    const days: { date: string; sessionOpenMs: number; sessionCloseMs: number }[] = [];
    // Sorted bars let us jump to the next day without formatting every timestamp.
    let first = 0;
    while (first < bars.length) {
      const open = bars[first].t_ms;
      const nextDay = (Math.floor((open + 9 * 3_600_000) / 86_400_000) + 1) * 86_400_000 - 9 * 3_600_000;
      let lo = first + 1, hi = bars.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (bars[mid].t_ms < nextDay) lo = mid + 1;
        else hi = mid;
      }
      days.push({ date: realMsToYyyymmdd(open), sessionOpenMs: open, sessionCloseMs: bars[lo - 1].t_ms });
      first = lo;
    }
    return createVirtualAxis(days, bars[0]?.t_ms ?? midnight);
  }, [bars, midnight]);
  const axisRef = useRef<VirtualAxis>(axis);
  const loadMore = useRef(() => {});
  useEffect(() => {
    loadMore.current = () => { if (hasNextPage && !isFetchingNextPage) void fetchNextPage(); };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{ candles: ISeriesApi<'Candlestick'>; volume: ISeriesApi<'Histogram'>; ma: ISeriesApi<'Line'> } | null>(null);
  const initial = useRef(true);
  const userGesture = useRef(false);
  const wheelGestureUntil = useRef(0);
  const writeSeries = useRef<ReturnType<typeof createSecondChartSeriesWriter> | null>(null);
  const previousBars = useRef(bars);
  const pendingViewport = useRef<SecondChartViewport | null>(null);
  const previousSession = useRef(regularSessionOnly);
  const setTimeframe = useWorkspaceStore(s => s.setChartTimeframe);
  const hoverLinked = win.chart?.hoverLinked ?? true;
  const hoverLinkedRef = useRef(hoverLinked);
  hoverLinkedRef.current = hoverLinked;
  const cursorThrottle = useRef<ReturnType<typeof createSidebarCursorThrottle> | null>(null);
  useEffect(() => {
    if (hoverLinked) return;
    cursorThrottle.current?.cancel();
    useLiveCursorStore.getState().clearSidebarCursorFrom(win.id);
  }, [hoverLinked, win.id]);

  useEffect(() => {
    if (!target) return;
    publishGroupChartLink({ windowId: win.id, group: win.group, code, timeframe, bundle: null,
      adjustFactors: undefined, todayKst: today, secondDate: date,
      vdist: { rangeCount: indicators.volumeDistributionRangeCount, color: indicators.volumeDistributionColor, regularSessionOnly,
        maxColor: indicators.volumeDistributionMaxColor, hoverCutoffEnabled: indicators.volumeDistributionHoverCutoffEnabled } });
    return () => clearGroupChartLink(win.group, win.id);
  }, [target, win.id, win.group, code, date, today, timeframe, regularSessionOnly, indicators.volumeDistributionRangeCount, indicators.volumeDistributionColor,
    indicators.volumeDistributionMaxColor, indicators.volumeDistributionHoverCutoffEnabled]);

  useEffect(() => {
    if (!container.current || !code) return;
    const style = getComputedStyle(container.current);
    const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const up = color('--price-up', '#ef4444'), down = color('--price-down', '#3b82f6');
    const chart = createPersistentCrosshairChart(createChart(container.current, {
      width: container.current.clientWidth, height: container.current.clientHeight,
      layout: { ...CHART_LAYOUT_OPTIONS, attributionLogo: false, background: { color: color('--bg-card', '#ffffff') }, textColor: color('--fg-dim', '#64748b') },
      grid: { vertLines: { visible: gridRef.current.verticalGrid, color: color('--border', '#e2e8f0') },
        horzLines: { visible: gridRef.current.horizontalGrid, color: color('--border', '#e2e8f0') } },
      timeScale: { timeVisible: true, secondsVisible: true, tickMarkFormatter: (t: Time) => typeof t === 'number' ? `${isoDate(realMsToYyyymmdd(axisRef.current.toReal(t * 1000))).slice(5)} ${kstTime(axisRef.current.toReal(t * 1000) / 1000)}` : '' },
      localization: { timeFormatter: (t: Time) => typeof t === 'number' ? `${isoDate(realMsToYyyymmdd(axisRef.current.toReal(t * 1000)))} ${kstTime(axisRef.current.toReal(t * 1000) / 1000)}` : '' },
    }));
    const candles = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 0);
    const ma = chart.addSeries(LineSeries, { color: color('--accent', '#2563eb'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false }, 1);
    chart.panes()[0].setStretchFactor(4);
    chart.panes()[1].setStretchFactor(1);
    const onRange = (range: { from: number; to: number } | null) => {
      if ((userGesture.current || performance.now() < wheelGestureUntil.current) && !initial.current && range && range.from < 10) {
        // setData/resize also emits range changes. Consume this gesture so a
        // single wheel movement cannot cascade into loading the entire day.
        userGesture.current = false;
        wheelGestureUntil.current = 0;
        loadMore.current();
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    let alive = true;
    const resize = new ResizeObserver(entries => {
      if (alive && entries[0]) chart.resize(Math.floor(entries[0].contentRect.width), Math.floor(entries[0].contentRect.height));
    });
    resize.observe(container.current);
    const throttle = createSidebarCursorThrottle(next => {
      if (!hoverLinkedRef.current) return false;
      if (useTradeBrowseStore.getState().session) return false;
      const store = useLiveCursorStore.getState();
      const origin = { windowId: win.id, group: win.group, code, timeframe, venue,
        barStartMs: next, regularSessionOnly: regularSessionOnlyRef.current };
      if (store.sidebarCursorMs === next && sameSidebarCursorOrigin(store.sidebarCursorOrigin, origin)) return false;
      store.setSidebarCursor(next, origin);
      return true;
    });
    cursorThrottle.current = throttle;
    const onCursor = (event: { time?: Time; sourceEvent?: unknown }) => {
      if (useTradeBrowseStore.getState().session) {
        if (!event.sourceEvent) return;
        releaseSyntheticCrosshair(chart);
        useTradeBrowseStore.getState().end();
      }
      if (hoverLinkedRef.current && typeof event.time === 'number') {
        throttle.schedule(axisRef.current.toReal(event.time * 1000));
      } else {
        throttle.cancel();
        useLiveCursorStore.getState().clearSidebarCursorFrom(win.id);
      }
    };
    chart.subscribeCrosshairMove(onCursor);
    if (import.meta.env.DEV) {
      const debug = window as unknown as { __liveCharts?: Map<string, IChartApi> };
      (debug.__liveCharts ??= new Map()).set(win.id, chart);
    }
    chartRef.current = chart;
    seriesRef.current = { candles, ma, volume };
    setTooltipChart({ chart, paneSeries: new Map<PaneId, ISeriesApi<SeriesType>>([['candle', candles], ['volume', volume]]) });
    writeSeries.current = createSecondChartSeriesWriter({ candles, ma, volume }, chart);
    userGesture.current = false;
    wheelGestureUntil.current = 0;
    initial.current = true;
    previousBars.current = [];
    pendingViewport.current = null;
    return () => {
      alive = false;
      resize.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.unsubscribeCrosshairMove(onCursor);
      throttle.cancel();
      cursorThrottle.current = null;
      useLiveCursorStore.getState().resetCursorFrom(win.id);
      if (import.meta.env.DEV) {
        const debug = window as unknown as { __liveCharts?: Map<string, IChartApi> };
        if (debug.__liveCharts?.get(win.id) === chart) debug.__liveCharts.delete(win.id);
      }
      queueMicrotask(() => chart.remove());
      chartRef.current = null;
      seriesRef.current = null;
      writeSeries.current = null;
    };
  }, [code, venue, midnight, win.id, win.group, timeframe]);

  useEffect(() => {
    const chart = chartRef.current, series = seriesRef.current;
    if (!chart || !series) return;
    chart.applyOptions({ grid: { horzLines: { visible: horizontalGrid }, vertLines: { visible: verticalGrid } } });
    const autoscaleInfoProvider: AutoscaleInfoProvider = original => candleOnlyScale ? null : original();
    series.ma.applyOptions({ autoscaleInfoProvider });
    series.candles.setSeriesOrder(candlesOnTop ? 1 : 0);
  }, [horizontalGrid, verticalGrid, candleOnlyScale, candlesOnTop, code, venue, midnight, win.id, win.group, timeframe]);

  const tooltipBundle = useMemo(() => ({ code: code ?? '', candles: tooltipEnabled ? bars.map(bar => ({
    ts_ms: bar.t_ms, open: bar.open, high: bar.high, low: bar.low, close: bar.close, vol_a: bar.volume, vol_b: 0,
  })) : [] }), [code, bars, tooltipEnabled]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const scale = chartRef.current?.timeScale();
    const sessionChanged = previousSession.current !== regularSessionOnly;
    const prefixChanged = bars.length > 0 && previousBars.current.length > 0 && bars[0].t_ms !== previousBars.current[0].t_ms;
    // Capture before an empty query page can erase the visible range. Preserve
    // candle spacing rather than fitting fewer filtered bars into the same time span.
    if ((sessionChanged || (!initial.current && prefixChanged)) && !pendingViewport.current && scale) {
      pendingViewport.current = captureSecondViewport(previousBars.current, scale.getVisibleLogicalRange(), scale.options().barSpacing);
    }
    previousSession.current = regularSessionOnly;
    if (!bars.length) {
      if (pendingViewport.current && (query.isPending || query.catalogPending || query.hasNextPage)) return;
      writeSeries.current?.(bars, axis);
      previousBars.current = bars;
      return;
    }
    axisRef.current = axis;
    writeSeries.current?.(bars, axis);
    if (pendingViewport.current && scale) {
      scale.setVisibleLogicalRange(restoreSecondViewport(bars, pendingViewport.current));
      scale.applyOptions({ barSpacing: pendingViewport.current.barSpacing });
      pendingViewport.current = null;
      initial.current = false;
    }
    previousBars.current = bars;
    if (initial.current && bars.length) {
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - SECOND_INITIAL_BARS), to: bars.length - 1 });
      if (bars.length >= SECOND_INITIAL_BARS || (!query.hasNextPage && !query.catalogPending)) initial.current = false;
    }
  }, [bars, axis, query.hasNextPage, query.catalogPending, query.isPending, regularSessionOnly]);

  useEffect(() => {
    if (bars.length < SECOND_INITIAL_BARS && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [bars.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return <div className="h-full flex flex-col bg-bg-card" data-testid="second-chart" data-day-count={axis.segments.length} data-bar-count={bars.length}>
    <div className="flex shrink-0 items-center gap-2 px-2 py-1 border-b border-border whitespace-nowrap overflow-x-auto">
      <span><TimeframeControl timeframe={timeframe} rememberedMinute={win.chart?.lastMinuteTimeframe ?? '1m'} onChange={tf => setTimeframe(win.id, tf)} secondsEnabled={symbol?.kind !== 'index' && symbol?.kind !== 'us_stock'} /></span>
      <RegularSessionAction win={win} />
      <CursorLinkAction win={win} showLabel />
    </div>
    <div className="relative min-h-0 flex-1">
      <div ref={container} className="absolute inset-0 font-data"
        onPointerDown={() => { userGesture.current = true; }}
        onPointerUp={() => { userGesture.current = false; }}
        onPointerCancel={() => { userGesture.current = false; }}
        onWheel={() => { wheelGestureUntil.current = performance.now() + 200; }} />
      <div className="absolute top-2 left-2 text-fg-dim pointer-events-none text-xs">MA 20 · 거래량</div>
      {tooltipEnabled && tooltipChart && <CandleTooltip chart={tooltipChart.chart} paneSeries={tooltipChart.paneSeries}
        bundle={tooltipBundle} axis={axis} timeframe={timeframe} />}
      {tooltipChart && <TradeBrowseCrosshair chart={tooltipChart.chart} axis={axis}
        candles={bars.map(bar => ({ ts_ms: bar.t_ms, close: bar.close }))} paneSeries={tooltipChart.paneSeries}
        windowId={win.id} group={win.group} code={code} timeframe={timeframe} venue={venue} enabled={hoverLinked}
        onNeedCandle={query.loadAt ? cursorMs => {
          setBrowseLoadError(false);
          void query.loadAt(cursorMs).catch(() => { setBrowseLoadError(true); });
        } : undefined} />}
      {(!bars.length || !code) && <div className="absolute inset-0 flex items-center justify-center text-fg-dim bg-bg-card/80">
        {!code ? '주식 종목을 선택해주세요' : query.isError ? '초봉을 불러오지 못했습니다' : query.isPending ? '초봉 불러오는 중' : '선택한 날짜에 저장된 초봉이 없습니다'}
      </div>}
    </div>
    {browseLoadError && <div role="alert" className="shrink-0 text-xs text-fg-dim">체결 탐색 초봉 조회 실패 · 다른 봉으로 이동하면 재시도합니다</div>}
    {query.hasNextPage && <button type="button" className="shrink-0 text-xs text-fg-dim hover:text-fg" disabled={query.isFetchingNextPage} onClick={() => loadMore.current()}>{query.isFetchingNextPage ? '이전 구간 불러오는 중' : '이전 구간 불러오기'}</button>}
    <div className="shrink-0 px-2 py-1 text-fg-dim text-xs" role="status">
      {query.storageError ? '저장 오류 · 일부 체결이 누락될 수 있습니다' : query.source === 'hogaplay' ? '과거 체결 원본 기준 · 미수집 구간은 포함되지 않습니다' : '수집된 체결 기준 · 미수집 구간은 포함되지 않습니다'}
    </div>
  </div>;
}
