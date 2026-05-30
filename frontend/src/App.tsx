import { Outlet } from 'react-router';
import LeftNav from './nav/LeftNav';
import RightRail from './rightrail/RightRail';
import { WatchlistDrawer } from './watchlist/WatchlistDrawer';
import { useRightRailStore } from './state/rightRail';
import { useEventStream } from './api/eventStream';
import { useInventoryRecaptureOriginsCleanup } from './inventory/useInventoryRecaptureOrigins';

export default function App() {
  useEventStream();
  useInventoryRecaptureOriginsCleanup();
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
