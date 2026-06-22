import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { isMinuteTimeframe, useLivePageStore } from '../state/livePage';
import type { StudyIndicatorState } from '../api/studyViews';
import { useLiveStatus } from '../api/liveStatus';
import { useLiveStatusProjection } from './liveStatusProjection';
import { LiveHeader } from './LiveHeader';
import { LiveStatusBar } from './LiveStatusBar';
import { LiveToolbar } from './LiveToolbar';
import { LiveWorkarea } from './LiveWorkarea';
import { LiveStateBanner } from './LiveStateBanner';
import { LiveTabBar } from './LiveTabBar';
import { useLiveTabsStore } from '../state/liveTabs';
import { focusLiveSearch } from './liveSearchFocus';
import { useLiveKeyboard } from './useLiveKeyboard';
import { useLiveBundle } from './useLiveBundle';
import { useLiveSeries } from '../api/liveSeries';
import { useDayAskPeaks, useTodayAllPriceAskPeak } from './useDayAskPeaks';
import { useDayBidPeaks, useTodayAllPriceBidPeak } from './useDayBidPeaks';
import type { AskPeak, BidPeak, Candle, RangeBundle } from '../api/types';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import type { TabViewport } from './viewportAnchor';
import { initialHistoricalDaysFor, subtractDaysKst, todayKstYyyymmdd } from './liveDateTime';
import { useChartPrefsStore } from '../state/chartPrefs';
import { useLiveVenueStore } from '../state/liveVenue';
import {
  clearCurrentStudySaveSource,
  setCurrentStudySaveSource,
  type LiveStudySaveSource,
} from '../studyViews/studySaveSource';
import { LiveStudyViewSaveButton } from '../studyViews/LiveStudyViewSaveButton';
import IndicatorPanel from './indicators/IndicatorPanel';
import LiveSettingsModal from './LiveSettingsModal';
import { useDocumentTitle } from '../util/useDocumentTitle';
import { indexInstrument, isLiveIndexId } from './liveInstrument';
import { useLiveIndexCandles, useLiveIndexInvestorNet } from '../api/liveIndices';
import { buildIndexBundle } from './buildIndexBundle';
import { capabilitiesForInstrument } from './liveInstrumentCapabilities';

/** 안정 빈 배열 — 매 렌더 새 [] 가 useDayAskPeaks의 메모 deps를 churn하지 않게. */
const EMPTY_ASK_PEAKS: readonly AskPeak[] = [];
const EMPTY_BID_PEAKS: readonly BidPeak[] = [];
const EMPTY_CANDLES: readonly Candle[] = [];
const EMPTY_OB_SNAPSHOTS: readonly ObSnapshot[] = [];
const EMPTY_TRADE_SNAPSHOTS: readonly TradeSnapshot[] = [];

const INDEX_BUCKET_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
  D: 86_400_000,
  W: 7 * 86_400_000,
  M: 31 * 86_400_000,
} as const;

/**
 * /live page — KIS-based real-time indicator chart.
 *
 * Six-row grid (Stage 9-β added LiveStateBanner; ADR-0069 adds the tab bar as row 2):
 *   1. LiveHeader      (var(--h-live-header))  — title + ⭐ toggle + symbol search
 *   2. LiveTabBar      (40px)                  — open stock tabs (ADR-0069)
 *   3. LiveStateBanner (auto)                  — empty/error state matrix
 *   4. LiveStatusBar   (var(--h-pricestrip))   — code/price/source/timeframe + cycle_lag pill
 *   5. LiveToolbar     (var(--h-toolbar))      — timeframe selector
 *   6. LiveWorkarea    (1fr)                   — chart + sidebar
 *
 * Active code resolution (CONTEXT.md / ADR-0052 / ADR-0069):
 *   useLivePageStore remains the single source of truth that all read sites
 *   consume for activeCode. The active *tab* (useLiveTabsStore → applyTabToPage)
 *   is now the single WRITER of that value. `?code=` is a one-shot deep-link
 *   SEED: on first mount it open-or-focuses a tab (which writes activeCode);
 *   thereafter search / ♥ / Watchlist writes flow through the tabs store and the
 *   URL never reverts them. With no `?code=`, the restored active tab is applied
 *   to the page on mount; with no tabs at all, LiveWorkarea shows the empty state.
 */
export function LivePage() {
  const [params] = useSearchParams();
  const queryCode = params.get('code');
  const queryIndex = params.get('index');
  const tabs = useLiveTabsStore((s) => s.tabs);
  const activeTabId = useLiveTabsStore((s) => s.activeTabId);
  const setActiveTabCode = useLiveTabsStore((s) => s.setActiveTabCode);
  const setActiveTabInstrument = useLiveTabsStore((s) => s.setActiveTabInstrument);
  const addBlankTab = useLiveTabsStore((s) => s.addBlankTab);
  const focusTab = useLiveTabsStore((s) => s.focusTab);
  const closeTab = useLiveTabsStore((s) => s.closeTab);
  const reorderTabs = useLiveTabsStore((s) => s.reorderTabs);

  // 1회: URL ?code= 시드는 현재 탭에 적용, 없으면 복원된 활성 탭을 page에 동기화,
  // 복원된 탭이 하나도 없으면 기본 빈 탭 1개를 만든다 — 항상 현재 탭이 존재해
  // 관심종목 클릭이 교체할 대상을 보장한다(단일-탭 내비게이션 모델, ADR-0069 개정).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (queryCode) setActiveTabCode(queryCode);
    else if (isLiveIndexId(queryIndex)) setActiveTabInstrument(indexInstrument(queryIndex, queryIndex));
    else if (activeTabId) focusTab(activeTabId); // 복원된 활성 탭 → page 동기화
    else addBlankTab();                          // 기본 탭 1개
  }, [queryCode, queryIndex, activeTabId, setActiveTabCode, setActiveTabInstrument, addBlankTab, focusTab]);

  const { data: status } = useLiveStatus();
  const liveStatus = useLiveStatusProjection(status);
  const banner = liveStatus.banner;

  // Keyboard shortcuts (Addendum 9.y / Design B7).
  // j/k traversal callbacks will be supplied by Stage 11 when the watchlist
  // panel is wired up; for now they're no-ops.
  // Tab switching (ADR-0069 / D6): ] next, [ prev, 1-9 jump to tab N.
  const activeIdx = tabs.findIndex((t) => t.id === activeTabId);
  useLiveKeyboard({
    onNextTab: () => { if (tabs.length) focusTab(tabs[(activeIdx + 1 + tabs.length) % tabs.length].id); },
    onPrevTab: () => { if (tabs.length) focusTab(tabs[(activeIdx - 1 + tabs.length) % tabs.length].id); },
    onSelectTabIndex: (i) => { if (i < tabs.length) focusTab(tabs[i].id); },
    onSelectTimeframeShortcut: (slot) => {
      const page = useLivePageStore.getState();
      const next = slot === 'minute' ? page.lastMinuteTimeframe : slot;
      page.setCandleTimeframe(next);
    },
  });

  const activeCode = useLivePageStore((s) => s.activeCode);
  const activeInstrument = useLivePageStore((s) => s.activeInstrument);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const historicalFromDate = useLivePageStore((s) => s.historicalFromDate);
  const liveVenue = useLiveVenueStore((s) => s.venue);
  const foreignNetEnabled = useLivePageStore((s) => s.foreignNetEnabled);
  const institutionNetEnabled = useLivePageStore((s) => s.institutionNetEnabled);
  const volumeEnabled = useLivePageStore((s) => s.volumeEnabled);
  const quoteTotalsEnabled = useLivePageStore((s) => s.quoteTotalsEnabled);
  const ratioEnabled = useLivePageStore((s) => s.ratioEnabled);
  const fillStrengthEnabled = useLivePageStore((s) => s.fillStrengthEnabled);
  const auctionWindowMask = useChartPrefsStore((s) => s.auctionWindowMask);
  const ratioIntraMax = useChartPrefsStore((s) => s.ratioIntraMax);
  const ratioOutlierFilterEnabled = useChartPrefsStore((s) => s.ratioOutlierFilterEnabled);
  const ratioOutlierThreshold = useChartPrefsStore((s) => s.ratioOutlierThreshold);
  // Active tab's saved viewport (ADR-0069 A안) → LiveChartRoot restores it on
  // cold switch-back. Stable reference (the tab object's viewport field) across
  // SSE renders; only rewritten on switch-away, so it doesn't thrash the chart.
  const restoreViewport = tabs.find((t) => t.id === activeTabId)?.viewport ?? null;
  useDocumentTitle(activeCode);
  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const viewportCaptureRef = useRef<() => TabViewport | null>(() => null);
  const handleViewportCaptureReady = useCallback((capture: () => TabViewport | null) => {
    viewportCaptureRef.current = capture;
  }, []);

  // Single live source for the page: useLiveSeries owns the SSE connection
  // and ring buffer; useLiveBundle composes it with KIS past-candles for the
  // chart; LiveSidebar reads ob/broker from the same buffer for LATEST mode.
  // Two independent useLiveSeries calls would open two SSE connections and
  // two buffers — HMR re-mounts cleared one but not the other, leaving the
  // sidebar's LATEST mode stuck on the empty-buffer state.
  const today = todayKstYyyymmdd();
  const live = useLiveSeries(activeCode ?? '');
  const { bundle, chartBundle, clampEngaged, isPastCandlesLoading, isExtending, pastDataWarnings } = useLiveBundle(
    activeCode,
    timeframe,
    today,
    live,
    { investorNetEnabled: foreignNetEnabled || institutionNetEnabled, venue: liveVenue },
  );
  const activeIndexId = activeInstrument?.kind === 'index' ? activeInstrument.id : null;
  const capabilities = useMemo(() => capabilitiesForInstrument(activeInstrument), [activeInstrument]);
  const indexFrom = historicalFromDate ?? subtractDaysKst(today, initialHistoricalDaysFor(timeframe));
  const indexCandles = useLiveIndexCandles(
    activeIndexId,
    timeframe,
    indexFrom,
    today,
  );
  const indexInvestorFrom = indexCandles.data?.from ?? indexFrom;
  const indexInvestorTo = indexCandles.data?.to ?? today;
  const indexInvestorNet = useLiveIndexInvestorNet(
    activeIndexId && timeframe === 'D' && capabilities.investorNet === 'market' ? activeIndexId : null,
    indexInvestorFrom,
    indexInvestorTo,
    timeframe === 'D' && capabilities.investorNet === 'market' && (foreignNetEnabled || institutionNetEnabled),
  );
  const indexBundle = useMemo<RangeBundle | null>(() => {
    if (!activeIndexId || !indexCandles.data) return null;
    return buildIndexBundle({
      indexId: activeIndexId,
      from: indexCandles.data.from,
      to: indexCandles.data.to,
      bucketMs: INDEX_BUCKET_MS[timeframe],
      candles: indexCandles.data.candles,
      investorPoints: indexInvestorNet.data?.points ?? [],
    });
  }, [activeIndexId, timeframe, indexCandles.data, indexInvestorNet.data?.points]);
  const indicatorState = useMemo<StudyIndicatorState>(() => ({
    volume_enabled: volumeEnabled,
    quote_totals_enabled: quoteTotalsEnabled,
    ratio_enabled: ratioEnabled,
    fill_strength_enabled: fillStrengthEnabled,
    aggregation_basis: ratioIntraMax ? 'intra_period_max' : 'close',
    auction_window_mask: auctionWindowMask,
    ratio_outlier_filter_enabled: ratioOutlierFilterEnabled,
    ratio_outlier_threshold: ratioOutlierThreshold,
  }), [
    auctionWindowMask,
    fillStrengthEnabled,
    quoteTotalsEnabled,
    ratioEnabled,
    ratioIntraMax,
    ratioOutlierFilterEnabled,
    ratioOutlierThreshold,
    volumeEnabled,
  ]);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const askPeakOb = isMinuteTimeframe(timeframe) ? live.ob : EMPTY_OB_SNAPSHOTS;
  const askPeakTrade = isMinuteTimeframe(timeframe) ? live.trade : EMPTY_TRADE_SNAPSHOTS;
  const askPeakSeeds = (chartBundle ?? bundle)?.ask_peaks ?? EMPTY_ASK_PEAKS;
  const askPeakCandles = isMinuteTimeframe(timeframe) ? ((chartBundle ?? bundle)?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES;
  const dayAskPeaks = useDayAskPeaks(
    askPeakOb,
    askPeakTrade,
    askPeakSeeds,
    today,
    activeCode,
    live.initial?.ask_peak_today ?? null,
    askPeakCandles,
  );
  const todayAllPriceAskPeak = useTodayAllPriceAskPeak(
    askPeakOb,
    askPeakSeeds,
    today,
    activeCode,
    live.initial?.ask_peak_today ?? null,
  );
  const bidPeakOb = isMinuteTimeframe(timeframe) ? live.ob : EMPTY_OB_SNAPSHOTS;
  const bidPeakTrade = isMinuteTimeframe(timeframe) ? live.trade : EMPTY_TRADE_SNAPSHOTS;
  const bidPeakSeeds = (chartBundle ?? bundle)?.bid_peaks ?? EMPTY_BID_PEAKS;
  const bidPeakCandles = isMinuteTimeframe(timeframe) ? ((chartBundle ?? bundle)?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES;
  const dayBidPeaks = useDayBidPeaks(
    bidPeakOb,
    bidPeakTrade,
    bidPeakSeeds,
    today,
    activeCode,
    live.initial?.bid_peak_today ?? null,
    bidPeakCandles,
  );
  const todayAllPriceBidPeak = useTodayAllPriceBidPeak(
    bidPeakOb,
    bidPeakSeeds,
    today,
    activeCode,
    live.initial?.bid_peak_today ?? null,
  );
  const liveSaveBundle = useMemo<RangeBundle | null>(() => {
    if (!bundle) return null;
    const base = chartBundle ?? bundle;
    return {
      ...bundle,
      from_date: base.from_date,
      to_date: base.to_date,
      bucket_ms: base.bucket_ms,
      segments: base.segments,
      candles: base.candles,
      volume_profile_range: base.volume_profile_range,
      volume_profile_by_day: base.volume_profile_by_day,
      investorPoints: base.investorPoints,
      ask_peaks: dayAskPeaks,
      bid_peaks: dayBidPeaks,
    };
  }, [bundle, chartBundle, dayAskPeaks, dayBidPeaks]);
  const workareaCode = activeCode ?? (activeIndexId ? `index:${activeIndexId}` : null);
  const workareaBundle = activeIndexId ? indexBundle : bundle;
  const workareaChartBundle = activeIndexId ? indexBundle : chartBundle;
  const workareaLoading = activeIndexId ? indexCandles.isLoading : isPastCandlesLoading;
  const indexExtending = activeIndexId ? historicalFromDate !== null && indexCandles.isFetching : false;
  const workareaDataWarnings = activeIndexId ? indexCandles.data?.data_warnings ?? [] : pastDataWarnings;

  useEffect(() => {
    if (!activeCode || !liveSaveBundle) {
      setCurrentStudySaveSource(null);
      return undefined;
    }
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: activeCode,
      label: activeTab?.label || activeCode,
      timeframe,
      bundle: liveSaveBundle,
      indicatorState,
      captureViewport: () => viewportCaptureRef.current(),
    };
    setCurrentStudySaveSource(source);
    return () => {
      clearCurrentStudySaveSource(source);
    };
  }, [activeCode, activeTab?.label, indicatorState, liveSaveBundle, timeframe]);

  return (
    <div
      className="h-full grid"
      style={{
        // minmax(0, 1fr) on the workarea row prevents the chart canvas's
        // intrinsic size from pushing the row past viewport height.
        gridTemplateRows:
          'var(--h-live-header) 40px auto var(--h-pricestrip) var(--h-toolbar) minmax(0, 1fr)',
      }}
    >
      <LiveHeader />
      <LiveTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        activeLoading={isPastCandlesLoading}
        onFocus={focusTab}
        onClose={closeTab}
        onReorder={reorderTabs}
        // + 버튼: 빈 탭을 만들고 검색창에 포커스 → 사용자가 바로 종목을 타이핑해 채운다(spec D5).
        // 마운트 시 기본 탭(위 시드)은 의도적으로 검색 포커스를 주지 않는다(로드마다 포커스 탈취 방지).
        onNewTab={() => { addBlankTab(); focusLiveSearch(); }}
      />
      <LiveStateBanner
        primary={workareaCode && banner.primary === 'watchlist_empty' ? null : banner.primary}
        stack={banner.stack}
      />
      <LiveStatusBar
        activeCode={workareaCode}
        captureHealth={liveStatus.captureHealth}
        bundle={workareaBundle}
        venue={liveVenue}
      />
      <LiveToolbar
        onOpenIndicators={() => setIndicatorPanelOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        studySaveControl={<LiveStudyViewSaveButton />}
      />
      <LiveWorkarea
        activeCode={workareaCode}
        bundle={workareaBundle}
        chartBundle={workareaChartBundle}
        clampEngaged={clampEngaged}
        isPastCandlesLoading={workareaLoading}
        isExtending={activeIndexId ? indexExtending : isExtending}
        pastDataWarnings={workareaDataWarnings}
        restoreViewport={restoreViewport}
        viewIdentity={activeTabId ? `${activeTabId}:${liveVenue}` : liveVenue}
        venue={liveVenue}
        live={live}
        dayAskPeaks={dayAskPeaks}
        todayAllPriceAskPeak={todayAllPriceAskPeak}
        dayBidPeaks={dayBidPeaks}
        todayAllPriceBidPeak={todayAllPriceBidPeak}
        todayKst={today}
        onViewportCaptureReady={handleViewportCaptureReady}
        paneTogglesOverride={{
          hogaPanes: capabilities.hogaPanes,
        }}
      />
      {indicatorPanelOpen && (
        <IndicatorPanel
          onClose={() => setIndicatorPanelOpen(false)}
          capabilities={capabilities}
        />
      )}
      {settingsOpen && (
        <LiveSettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

export default LivePage;
