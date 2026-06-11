import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useLivePageStore } from '../state/livePage';
import { useLiveStatus } from '../api/liveStatus';
import { useLiveBannerState } from './useLiveBannerState';
import { LiveHeader } from './LiveHeader';
import { LiveStatusBar } from './LiveStatusBar';
import { LiveToolbar } from './LiveToolbar';
import { LiveWorkarea } from './LiveWorkarea';
import { LiveStateBanner } from './LiveStateBanner';
import { LiveTabBar } from './LiveTabBar';
import { useLiveTabsStore, TABS_SOFT_CAP } from '../state/liveTabs';
import { focusLiveSearch } from './liveSearchFocus';
import { useLiveKeyboard } from './useLiveKeyboard';
import { useLiveBundle } from './useLiveBundle';
import { useLiveSeries } from '../api/liveSeries';
import { todayKstYyyymmdd } from './liveDateTime';
import IndicatorPanel from './indicators/IndicatorPanel';
import LiveSettingsModal from './LiveSettingsModal';
import { useDocumentTitle } from '../util/useDocumentTitle';

/**
 * /live page — KIS-based real-time indicator chart.
 *
 * Five-row grid (Stage 9-β adds LiveStateBanner as auto-sized row 2):
 *   1. LiveHeader      (var(--h-live-header))  — title + ⭐ toggle
 *   2. LiveStateBanner (auto)                  — empty/error state matrix
 *   3. LiveStatusBar   (var(--h-pricestrip))   — code/price/source/timeframe + cycle_lag pill
 *   4. LiveToolbar     (var(--h-toolbar))      — timeframe selector
 *   5. LiveWorkarea    (1fr)                   — chart + sidebar (filled by 9-γ + 11)
 *
 * Active code resolution (CONTEXT.md / ADR-0052):
 *   The `livePage` store is the single source of truth for activeCode. `?code=`
 *   is a one-shot deep-link SEED — adopted into the store once on first mount,
 *   after which search / ♥ / Watchlist Panel writes always win and are never
 *   reverted by the URL. (Future, Stage 11) first watchlist entry; empty state
 *   otherwise.
 */
export function LivePage() {
  const [params] = useSearchParams();
  const queryCode = params.get('code');
  const tabs = useLiveTabsStore((s) => s.tabs);
  const activeTabId = useLiveTabsStore((s) => s.activeTabId);
  const openOrFocusTab = useLiveTabsStore((s) => s.openOrFocusTab);
  const focusTab = useLiveTabsStore((s) => s.focusTab);
  const closeTab = useLiveTabsStore((s) => s.closeTab);
  const reorderTabs = useLiveTabsStore((s) => s.reorderTabs);

  // 1회: URL ?code= 시드는 복원된 탭 위에 open-or-focus, 없으면 복원된 활성 탭을 page에 적용.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (queryCode) openOrFocusTab(queryCode);
    else if (activeTabId) focusTab(activeTabId); // 복원된 활성 탭 → page 동기화
  }, [queryCode, activeTabId, openOrFocusTab, focusTab]);

  const { data: status } = useLiveStatus();
  const banner = useLiveBannerState(status);

  // Keyboard shortcuts (Addendum 9.y / Design B7).
  // j/k traversal callbacks will be supplied by Stage 11 when the watchlist
  // panel is wired up; for now they're no-ops.
  useLiveKeyboard({});

  const activeCode = useLivePageStore((s) => s.activeCode);
  useDocumentTitle(activeCode);
  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Single live source for the page: useLiveSeries owns the SSE connection
  // and ring buffer; useLiveBundle composes it with KIS past-candles for the
  // chart; LiveSidebar reads ob/broker from the same buffer for LATEST mode.
  // Two independent useLiveSeries calls would open two SSE connections and
  // two buffers — HMR re-mounts cleared one but not the other, leaving the
  // sidebar's LATEST mode stuck on the empty-buffer state.
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const today = todayKstYyyymmdd();
  const live = useLiveSeries(activeCode ?? '');
  const { bundle, chartBundle, clampEngaged, isPastCandlesLoading, isExtending, pastDataWarnings } = useLiveBundle(
    activeCode,
    timeframe,
    today,
    live,
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
        atCap={tabs.length >= TABS_SOFT_CAP}
        onFocus={focusTab}
        onClose={closeTab}
        onReorder={reorderTabs}
        onNewTab={focusLiveSearch}
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
      />
      <LiveWorkarea
        activeCode={activeCode}
        bundle={bundle}
        chartBundle={chartBundle}
        clampEngaged={clampEngaged}
        isPastCandlesLoading={isPastCandlesLoading}
        isExtending={isExtending}
        pastDataWarnings={pastDataWarnings}
        live={live}
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
