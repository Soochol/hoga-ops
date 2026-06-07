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
      style={{
        gridTemplateColumns: cols,
        // minmax(0, 1fr) — 행을 명시하지 않으면 암시적 auto 행이 패널(관심/스크리너)
        // 콘텐츠 높이까지 자라 같은 행의 <main>(차트)이 뷰포트를 넘는다. 그룹
        // 접기/펼치기마다 차트 높이가 출렁이던 버그의 근본 원인 (LivePage 워크
        // 영역 행과 같은 계약). 주의: 직계 자식을 새로 추가해 2행이 되면 그 행은
        // 다시 암시적 auto가 되므로 행 정의를 함께 갱신할 것.
        gridTemplateRows: 'minmax(0, 1fr)',
      }}
    >
      <LeftNav />
      <main className="overflow-hidden min-w-0"><Outlet /></main>
      {activePanel === 'watchlist' && <WatchlistDrawer />}
      {activePanel === 'screener' && <ScreenerDrawer />}
      <RightRail />
    </div>
  );
}
