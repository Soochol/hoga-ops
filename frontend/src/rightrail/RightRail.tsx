import { useRightRailStore } from '../state/rightRail';
import { HeartIcon } from '../ui/HeartIcon';

/**
 * Global Right Rail (ADR-0052) — fixed thin right-edge chrome on every route.
 * The rail itself does not collapse; both the chevron and the single 관심 item
 * show/hide the Watchlist Panel (which opens to the rail's left). Mounted by
 * App; the panel body is the WatchlistDrawer.
 */
export default function RightRail() {
  const panelOpen = useRightRailStore((s) => s.panelOpen);
  const togglePanel = useRightRailStore((s) => s.togglePanel);

  return (
    <nav
      aria-label="우측 레일"
      className="flex flex-col items-center h-full bg-bg-subtle border-l"
      style={{ width: 'var(--rail-w)' }}
    >
      <button
        type="button"
        onClick={togglePanel}
        aria-expanded={panelOpen}
        aria-controls="right-rail-watchlist-panel"
        aria-label={panelOpen ? '관심종목 패널 닫기' : '관심종목 패널 열기'}
        className="w-full py-2 grid place-items-center text-fg-dim hover:text-fg hover:bg-bg-input-hover"
      >
        {panelOpen ? '»' : '«'}
      </button>
      <button
        type="button"
        onClick={togglePanel}
        aria-pressed={panelOpen}
        aria-controls="right-rail-watchlist-panel"
        aria-label="관심종목 패널 토글"
        // Active = tint bg + neutral text, matching NavItem (no triple-teal).
        // The heart fill (currentColor=fg) is a shape signal, not a 2nd accent.
        className={`w-full py-3 flex flex-col items-center gap-1 ${
          panelOpen
            ? 'bg-tint-selection text-fg'
            : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
        }`}
      >
        <HeartIcon filled={panelOpen} className="w-[1.125em] h-[1.125em]" />
        <span className="text-xs">관심</span>
      </button>
    </nav>
  );
}
