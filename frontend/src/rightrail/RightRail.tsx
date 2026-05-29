import { useRightRailStore } from '../state/rightRail';

/**
 * Global Right Rail (ADR-0052) — thin right-edge chrome on every route.
 * Top chevron toggles rail collapse; the single 관심 item toggles the
 * Watchlist Panel. Mounted by App; the panel itself is the WatchlistDrawer.
 */
export default function RightRail() {
  const panelOpen = useRightRailStore((s) => s.panelOpen);
  const railCollapsed = useRightRailStore((s) => s.railCollapsed);
  const togglePanel = useRightRailStore((s) => s.togglePanel);
  const toggleRailCollapsed = useRightRailStore((s) => s.toggleRailCollapsed);

  return (
    <nav
      aria-label="Right Rail"
      className="flex flex-col items-center h-full bg-bg-subtle border-l"
      style={{ width: railCollapsed ? 'var(--rail-handle-w)' : 'var(--rail-w)' }}
    >
      <button
        type="button"
        onClick={toggleRailCollapsed}
        aria-label={railCollapsed ? '레일 펼치기' : '레일 접기'}
        aria-expanded={!railCollapsed}
        className="w-full py-2 grid place-items-center text-fg-dim hover:text-fg hover:bg-bg-input-hover"
      >
        {railCollapsed ? '«' : '»'}
      </button>
      {!railCollapsed && (
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
          <HeartIcon filled={panelOpen} />
          <span className="text-xs">관심</span>
        </button>
      )}
    </nav>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}
