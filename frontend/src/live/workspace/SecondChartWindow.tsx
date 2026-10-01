/** First seconds rollout: observed second candles, volume and a 20-bar MA.
 * A separate pipeline prevents minute vendor requests and slower indicator
 * interpolation from silently pretending to be second-resolution data.
 */
import { useEffect, useMemo, useRef } from 'react';
import { CandlestickSeries, HistogramSeries, LineSeries, createChart, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import { useSecondHistory, SECOND_INITIAL_BARS } from '../../api/secondHistory';
import { createVirtualAxis, type VirtualAxis } from '../../util/virtualAxis';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useWorkspaceStore, type WorkspaceWindow, type GroupSymbol } from '../../state/workspace';
import { ChartMoreActions } from './ChartMoreActions';
import { RegularSessionAction } from './RegularSessionAction';
import { TimeframeControl } from '../TimeframeControl';
import { useEffectiveVenue } from '../useEffectiveVenue';
import { useWindowIndicators } from './windowView';
import { publishGroupChartLink, clearGroupChartLink } from './groupChartLinkSource';
import { groupTargetChartWindow } from '../../state/workspace';
import { useLiveCursorStore } from '../useLiveCursorStore';
import { movingAverageSeconds } from './secondAggregateProjectors';
import type { LiveVenueOption } from '../../state/liveVenue';
import { useMinuteClock } from '../useMinuteClock';
import { realMsToYyyymmdd } from '../liveDateTime';
import { useThemeChangeRerender } from '../../state/themePrefs';
import { currentThemeKey } from '../../util/tokens';
import { bucketSeconds, type SecondTimeframe } from '../../state/livePage';
import { CHART_LAYOUT_OPTIONS } from '../../util/chartScale';

const kstTime = (value: number) => new Date(value * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour12: false });
const isoDate = (date: string) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
const time = (ms: number) => ms / 1000 as UTCTimestamp;

type Props = { win: WorkspaceWindow; symbol: GroupSymbol | null; timeframe: SecondTimeframe };
export function SecondChartWindow({ win, symbol, timeframe }: Props) {
  useThemeChangeRerender();
  const selectedVenue = useLiveVenueStore(s => s.venue);
  const code = symbol?.kind === 'index' ? null : symbol?.code ?? null;
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
  const query = useSecondHistory(code, venue, date, seconds, regularSessionOnly);
  const bars = query.bars;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const axis = useMemo(() => {
    const days = new Map<string, { date: string; sessionOpenMs: number; sessionCloseMs: number }>();
    for (const bar of bars) {
      const key = realMsToYyyymmdd(bar.t_ms);
      const day = days.get(key);
      if (day) day.sessionCloseMs = bar.t_ms;
      else days.set(key, { date: key, sessionOpenMs: bar.t_ms, sessionCloseMs: bar.t_ms });
    }
    return createVirtualAxis([...days.values()], bars[0]?.t_ms ?? midnight);
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
  const previousFirst = useRef<number | null>(null);
  const previousSession = useRef(regularSessionOnly);
  const setTimeframe = useWorkspaceStore(s => s.setChartTimeframe);

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
    const chart = createChart(container.current, {
      width: container.current.clientWidth, height: container.current.clientHeight,
      layout: { ...CHART_LAYOUT_OPTIONS, attributionLogo: false, background: { color: color('--bg-card', '#ffffff') }, textColor: color('--fg-dim', '#64748b') },
      grid: { vertLines: { visible: false }, horzLines: { color: color('--border', '#e2e8f0') } },
      timeScale: { timeVisible: true, secondsVisible: true, tickMarkFormatter: (t: Time) => typeof t === 'number' ? `${isoDate(realMsToYyyymmdd(axisRef.current.toReal(t * 1000))).slice(5)} ${kstTime(axisRef.current.toReal(t * 1000) / 1000)}` : '' },
      localization: { timeFormatter: (t: Time) => typeof t === 'number' ? `${isoDate(realMsToYyyymmdd(axisRef.current.toReal(t * 1000)))} ${kstTime(axisRef.current.toReal(t * 1000) / 1000)}` : '' },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 0);
    const ma = chart.addSeries(LineSeries, { color: color('--accent', '#2563eb'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false }, 1);
    chart.panes()[0].setStretchFactor(4);
    chart.panes()[1].setStretchFactor(1);
    const onRange = (range: { from: number; to: number } | null) => {
      if (userGesture.current && !initial.current && range && range.from < 10) {
        // setData/resize also emits range changes. Consume this gesture so a
        // single wheel movement cannot cascade into loading the entire day.
        userGesture.current = false;
        loadMore.current();
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    let alive = true;
    const resize = new ResizeObserver(entries => {
      if (alive && entries[0]) chart.resize(Math.floor(entries[0].contentRect.width), Math.floor(entries[0].contentRect.height));
    });
    resize.observe(container.current);
    const onCursor = (event: { time?: Time }) => {
      const store = useLiveCursorStore.getState();
      if (typeof event.time === 'number') store.setSidebarCursor(axisRef.current.toReal(event.time * 1000),
        { windowId: win.id, group: win.group, code, timeframe });
      else store.clearSidebarCursorFrom(win.id);
    };
    chart.subscribeCrosshairMove(onCursor);
    chartRef.current = chart;
    seriesRef.current = { candles, ma, volume };
    initial.current = true;
    previousFirst.current = null;
    return () => {
      alive = false;
      resize.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.unsubscribeCrosshairMove(onCursor);
      useLiveCursorStore.getState().resetCursorFrom(win.id);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [code, venue, midnight, win.id, win.group, timeframe]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    // A session query first resolves today's empty page before walking older dates.
    // Preserve the existing axis/range until there are time points to restore onto.
    if (!bars.length) {
      series.candles.setData([]);
      series.volume.setData([]);
      series.ma.setData([]);
      return;
    }
    const priorRange = previousFirst.current !== null && (bars[0]?.t_ms !== previousFirst.current || previousSession.current !== regularSessionOnly)
      ? chartRef.current?.timeScale().getVisibleRange() : null;
    const oldAxis = axisRef.current;
    axisRef.current = axis;
    const projectedTime = (ms: number) => time(axis.toVirtual(ms));
    series.candles.setData(bars.map(bar => ({ time: projectedTime(bar.t_ms), open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
    const { upColor, downColor } = series.candles.options();
    series.volume.setData(bars.map(bar => ({ time: projectedTime(bar.t_ms), value: bar.volume,
      color: bar.close >= bar.open ? upColor : downColor })));
    series.ma.setData(movingAverageSeconds(bars, 20).map(point => ({ ...point, time: projectedTime(Number(point.time) * 1000) })));
    if (priorRange && !initial.current) {
      const from = oldAxis.toReal(Number(priorRange.from) * 1000);
      const to = oldAxis.toReal(Number(priorRange.to) * 1000);
      const first = bars[0].t_ms, last = bars[bars.length - 1].t_ms;
      if (from >= last || to <= first) {
        chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - SECOND_INITIAL_BARS), to: bars.length - 1 });
      } else {
        chartRef.current?.timeScale().setVisibleRange({ from: projectedTime(Math.max(first, from)), to: projectedTime(Math.min(last, to)) });
      }
    }
    previousFirst.current = bars[0]?.t_ms ?? null;
    previousSession.current = regularSessionOnly;
    if (initial.current && bars.length) {
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - SECOND_INITIAL_BARS), to: bars.length - 1 });
      if (bars.length >= SECOND_INITIAL_BARS || (!query.hasNextPage && !query.catalogPending)) initial.current = false;
    }
  }, [bars, axis, query.hasNextPage, query.catalogPending, regularSessionOnly]);

  useEffect(() => {
    if (bars.length < SECOND_INITIAL_BARS && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [bars.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return <div className="h-full flex flex-col bg-bg-card" data-testid="second-chart" data-day-count={axis.segments.length} data-bar-count={bars.length}>
    <div className="flex shrink-0 items-center gap-2 px-2 py-1 border-b border-border whitespace-nowrap overflow-x-auto">
      <span><TimeframeControl timeframe={timeframe} rememberedMinute={win.chart?.lastMinuteTimeframe ?? '1m'} onChange={tf => setTimeframe(win.id, tf)} secondsEnabled={symbol?.kind !== 'index'} /></span>
      <ChartMoreActions><RegularSessionAction win={win} /></ChartMoreActions>
    </div>
    <div className="relative min-h-0 flex-1">
      <div ref={container} className="absolute inset-0 font-data"
        onPointerDown={() => { userGesture.current = true; }}
        onPointerUp={() => { userGesture.current = false; }}
        onPointerCancel={() => { userGesture.current = false; }}
        onWheel={() => { userGesture.current = true; }} />
      <div className="absolute top-2 left-2 text-fg-dim pointer-events-none text-xs">MA 20 · 거래량</div>
      {(!bars.length || !code) && <div className="absolute inset-0 flex items-center justify-center text-fg-dim bg-bg-card/80">
        {!code ? '주식 종목을 선택해주세요' : query.isError ? '초봉을 불러오지 못했습니다' : query.isPending ? '초봉 불러오는 중' : '선택한 날짜에 저장된 초봉이 없습니다'}
      </div>}
    </div>
    {query.hasNextPage && <button type="button" className="shrink-0 text-xs text-fg-dim hover:text-fg" disabled={query.isFetchingNextPage} onClick={() => loadMore.current()}>{query.isFetchingNextPage ? '이전 구간 불러오는 중' : '이전 구간 불러오기'}</button>}
    <div className="shrink-0 px-2 py-1 text-fg-dim text-xs" role="status">
      {query.storageError ? '저장 오류 · 일부 체결이 누락될 수 있습니다' : query.source === 'hogaplay' ? '과거 체결 원본 기준 · 미수집 구간은 포함되지 않습니다' : '수집된 체결 기준 · 미수집 구간은 포함되지 않습니다'}
    </div>
  </div>;
}
