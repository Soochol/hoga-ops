import { Outlet } from 'react-router';
import LeftNav from './nav/LeftNav';
import RightRail from './rightrail/RightRail';
import { WatchlistDrawer } from './watchlist/WatchlistDrawer';
import { ScreenerDrawer } from './screener/ScreenerDrawer';
import { useRightRailStore } from './state/rightRail';
import { useEventStream } from './api/eventStream';
import { useInventoryRecaptureOriginsCleanup } from './inventory/useInventoryRecaptureOrigins';
import { useCaptureQueueSync } from './capture/useCaptureQueue';

export default function App() {
  useEventStream();
  useInventoryRecaptureOriginsCleanup();
  // Single owner of the capture-queue push subscription (was fanned out across
  // ~5 useCaptureQueue mounts); the read side now only reads the shared cache.
  useCaptureQueueSync();
  const activePanel = useRightRailStore((s) => s.activePanel);

  // The Right Rail is fixed (always --rail-w); one panel column appears between
  // main and the rail when a panel is open. Grid track count always equals
  // rendered child count: 3 when no panel, 4 when one is open. Panels are
  // mutually exclusive (enum activePanel), so there is never a 2nd panel column.
  const cols = `var(--nav-w) 1fr${activePanel ? ' var(--watchlist-panel-w)' : ''} var(--rail-w)`;

  return (
    <div
      className="grid h-screen w-screen overflow-hidden"
      style={{ gridTemplateColumns: cols }}
    >
      <LeftNav />
      <main className="overflow-hidden min-w-0"><Outlet /></main>
      {activePanel === 'watchlist' && <WatchlistDrawer />}
      {activePanel === 'screener' && <ScreenerDrawer />}
      <RightRail />
    </div>
  );
}
