import { Outlet } from 'react-router';
import LeftNav from './nav/LeftNav';
import RightRail from './rightrail/RightRail';
import { WatchlistDrawer } from './watchlist/WatchlistDrawer';
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
  const panelOpen = useRightRailStore((s) => s.panelOpen);

  // The Right Rail is fixed (always --rail-w); the Watchlist Panel column
  // appears between main and the rail only when open. Grid track count always
  // equals rendered child count: 3 closed, 4 open.
  const cols = `var(--nav-w) 1fr${panelOpen ? ' var(--watchlist-panel-w)' : ''} var(--rail-w)`;

  return (
    <div
      className="grid h-screen w-screen overflow-hidden"
      style={{ gridTemplateColumns: cols }}
    >
      <LeftNav />
      <main className="overflow-hidden min-w-0"><Outlet /></main>
      {panelOpen && <WatchlistDrawer />}
      <RightRail />
    </div>
  );
}
