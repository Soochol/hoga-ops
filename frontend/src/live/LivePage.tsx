import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { isMinuteTimeframe, useLivePageStore } from '../state/livePage';
import type { StudyIndicatorState } from '../api/studyViews';
import { useLiveStatus } from '../api/liveStatus';
import { useLiveBannerState } from './useLiveBannerState';
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
import type { AskPeak, RangeBundle } from '../api/types';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import type { TabViewport } from './viewportAnchor';
import { todayKstYyyymmdd } from './liveDateTime';
import { useChartPrefsStore } from '../state/chartPrefs';
import {
  clearCurrentStudySaveSource,
  setCurrentStudySaveSource,
  type LiveStudySaveSource,
} from '../studyViews/studySaveSource';
import { LiveStudyViewSaveButton } from '../studyViews/LiveStudyViewSaveButton';
import IndicatorPanel from './indicators/IndicatorPanel';
import LiveSettingsModal from './LiveSettingsModal';
import { useDocumentTitle } from '../util/useDocumentTitle';

/** 안정 빈 배열 — 매 렌더 새 [] 가 useDayAskPeaks의 메모 deps를 churn하지 않게. */
const EMPTY_ASK_PEAKS: readonly AskPeak[] = [];
const EMPTY_OB_SNAPSHOTS: readonly ObSnapshot[] = [];
const EMPTY_TRADE_SNAPSHOTS: readonly TradeSnapshot[] = [];

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
  const tabs = useLiveTabsStore((s) => s.tabs);
  const activeTabId = useLiveTabsStore((s) => s.activeTabId);
  const setActiveTabCode = useLiveTabsStore((s) => s.setActiveTabCode);
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
    else if (activeTabId) focusTab(activeTabId); // 복원된 활성 탭 → page 동기화
    else addBlankTab();                          // 기본 탭 1개
  }, [queryCode, activeTabId, setActiveTabCode, addBlankTab, focusTab]);

  const { data: status } = useLiveStatus();
  const banner = useLiveBannerState(status);

  // Keyboard shortcuts (Addendum 9.y / Design B7).
  // j/k traversal callbacks will be supplied by Stage 11 when the watchlist
  // panel is wired up; for now they're no-ops.
  // Tab switching (ADR-0069 / D6): ] next, [ prev, 1-9 jump to tab N.
  const activeIdx = tabs.findIndex((t) => t.id === activeTabId);
  useLiveKeyboard({
    onNextTab: () => { if (tabs.length) focusTab(tabs[(activeIdx + 1 + tabs.length) % tabs.length].id); },
    onPrevTab: () => { if (tabs.length) focusTab(tabs[(activeIdx - 1 + tabs.length) % tabs.length].id); },
    onSelectTabIndex: (i) => { if (i < tabs.length) focusTab(tabs[i].id); },
  });

  const activeCode = useLivePageStore((s) => s.activeCode);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
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
  );
  const liveSaveBundle = useMemo<RangeBundle | null>(() => {
    if (!bundle) return null;
    if (!chartBundle) return bundle;
    return {
      ...bundle,
      from_date: chartBundle.from_date,
      to_date: chartBundle.to_date,
      bucket_ms: chartBundle.bucket_ms,
      segments: chartBundle.segments,
      candles: chartBundle.candles,
      volume_profile_range: chartBundle.volume_profile_range,
      volume_profile_by_day: chartBundle.volume_profile_by_day,
      investorPoints: chartBundle.investorPoints,
      ask_peaks: chartBundle.ask_peaks,
    };
  }, [bundle, chartBundle]);
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
  const askPeakOb = isMinuteTimeframe(timeframe) ? live.ob : EMPTY_OB_SNAPSHOTS;
  const askPeakTrade = isMinuteTimeframe(timeframe) ? live.trade : EMPTY_TRADE_SNAPSHOTS;
  const askPeakSeeds = (chartBundle ?? bundle)?.ask_peaks ?? EMPTY_ASK_PEAKS;
  const dayAskPeaks = useDayAskPeaks(
    askPeakOb,
    askPeakTrade,
    askPeakSeeds,
    today,
    activeCode,
    live.initial?.ask_peak_today ?? null,
  );
  const todayAllPriceAskPeak = useTodayAllPriceAskPeak(
    askPeakOb,
    askPeakSeeds,
    today,
    activeCode,
    live.initial?.ask_peak_today ?? null,
  );

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
        primary={activeCode && banner.primary === 'watchlist_empty' ? null : banner.primary}
        stack={banner.stack}
      />
      <LiveStatusBar
        activeCode={activeCode}
        captureHealthy={status?.capture_healthy ?? false}
        captureReason={status?.capture_reason ?? 'offline'}
        bundle={bundle}
      />
      <LiveToolbar
        onOpenIndicators={() => setIndicatorPanelOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        studySaveControl={<LiveStudyViewSaveButton />}
      />
      <LiveWorkarea
        activeCode={activeCode}
        bundle={bundle}
        chartBundle={chartBundle}
        clampEngaged={clampEngaged}
        isPastCandlesLoading={isPastCandlesLoading}
        isExtending={isExtending}
        pastDataWarnings={pastDataWarnings}
        restoreViewport={restoreViewport}
        live={live}
        dayAskPeaks={dayAskPeaks}
        todayAllPriceAskPeak={todayAllPriceAskPeak}
        todayKst={today}
        onViewportCaptureReady={handleViewportCaptureReady}
      />
      {indicatorPanelOpen && (
        <IndicatorPanel onClose={() => setIndicatorPanelOpen(false)} />
      )}
      {settingsOpen && (
        <LiveSettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

export default LivePage;
