import { Outlet, useLocation } from 'react-router';
import TopNav from './nav/TopNav';
import { SYSTEM_NAV_ITEMS, WORKSPACE_NAV_ITEMS } from './nav/items';
import RightRail from './rightrail/RightRail';
import { WatchlistDrawer } from './watchlist/WatchlistDrawer';
import { ScreenerDrawer } from './screener/ScreenerDrawer';
import { StudyViewsDrawer } from './studyViews/StudyViewsDrawer';
import SignalAlertsDrawer from './signalAlerts/SignalAlertsDrawer';
import { useRightRailStore } from './state/rightRail';
import { useEventStream } from './api/eventStream';
import { useInventoryRecaptureOriginsCleanup } from './inventory/useInventoryRecaptureOrigins';
import { useCaptureQueueSync } from './capture/useCaptureQueue';
import { useStaticDocumentTitle } from './util/useDocumentTitle';

const STATIC_ROUTE_TITLES: ReadonlyMap<string, string> = new Map(
  [...WORKSPACE_NAV_ITEMS, ...SYSTEM_NAV_ITEMS]
    .filter((item) => item.to !== '/live')
    .map((item) => [item.to, item.label] as const),
);

export default function App() {
  useEventStream();
  useInventoryRecaptureOriginsCleanup();
  // Single owner of the capture-queue push subscription (was fanned out across
  // ~5 useCaptureQueue mounts); the read side now only reads the shared cache.
  useCaptureQueueSync();
  const activePanel = useRightRailStore((s) => s.activePanel);

  // The top row is fixed; the content row owns main + optional right panel +
  // fixed rail. Keeping this as a nested grid prevents panel content from
  // inflating the chart row and returns the retired side-menu width to main.
  const contentCols = `1fr${activePanel ? ' var(--watchlist-panel-w)' : ''} var(--rail-w)`;
  const { pathname } = useLocation();
  const staticTitle = pathname === '/live' ? null : STATIC_ROUTE_TITLES.get(pathname) ?? 'hoga-ops';

  return (
    <div
      className="grid h-screen w-screen overflow-hidden"
      style={{
        gridTemplateRows: 'var(--h-top-nav) minmax(0, 1fr)',
      }}
    >
      {staticTitle !== null && <StaticDocumentTitle title={staticTitle} />}
      <TopNav />
      <div
        data-testid="app-content-grid"
        className="grid min-h-0 min-w-0 overflow-hidden"
        style={{ gridTemplateColumns: contentCols }}
      >
        <main className="overflow-hidden min-w-0"><Outlet /></main>
        {activePanel === 'watchlist' && <WatchlistDrawer />}
        {activePanel === 'screener' && <ScreenerDrawer />}
        {activePanel === 'savedViews' && <StudyViewsDrawer />}
        {activePanel === 'signalAlerts' && <SignalAlertsDrawer />}
        <RightRail />
      </div>
    </div>
  );
}

function StaticDocumentTitle({ title }: { title: string }) {
  useStaticDocumentTitle(title);
  return null;
}
