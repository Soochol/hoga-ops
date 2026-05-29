import { Outlet } from 'react-router';
import LeftNav from './nav/LeftNav';
import RightRail from './rightrail/RightRail';
import { WatchlistDrawer } from './watchlist/WatchlistDrawer';
import { useRightRailStore } from './state/rightRail';
import { useEventStream } from './api/sse';
import { useInventoryRecaptureOriginsCleanup } from './inventory/useInventoryRecaptureOrigins';

export default function App() {
  useEventStream();
  useInventoryRecaptureOriginsCleanup();
  const panelOpen = useRightRailStore((s) => s.panelOpen);
  const railCollapsed = useRightRailStore((s) => s.railCollapsed);

  // Panel-open ⟹ rail-expanded (store invariant); guard defensively so the
  // rendered children always match the grid track count.
  const showPanel = panelOpen && !railCollapsed;
  const railTrack = railCollapsed ? 'var(--rail-handle-w)' : 'var(--rail-w)';
  const cols = `var(--nav-w) 1fr${showPanel ? ' var(--watchlist-panel-w)' : ''} ${railTrack}`;

  return (
    <div
      className="grid h-screen w-screen overflow-hidden"
      style={{ gridTemplateColumns: cols }}
    >
      <LeftNav />
      <main className="overflow-hidden min-w-0"><Outlet /></main>
      {showPanel && <WatchlistDrawer />}
      <RightRail />
    </div>
  );
}
