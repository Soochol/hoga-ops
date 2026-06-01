import { useRightRailStore, type RailPanel } from '../state/rightRail';
import { HeartIcon } from '../ui/HeartIcon';
import { FunnelIcon } from '../ui/FunnelIcon';

/**
 * Global Right Rail (ADR-0052) — fixed thin right-edge chrome on every route.
 * The rail itself does not collapse. It now holds two items: 관심 (Watchlist)
 * and 스크리너 (Screener); each toggles its own panel (mutually exclusive — one
 * panel slot). The chevron collapses the open panel and re-opens the last one.
 */
export default function RightRail() {
  const activePanel = useRightRailStore((s) => s.activePanel);
  const togglePanel = useRightRailStore((s) => s.togglePanel);
  const toggleCollapse = useRightRailStore((s) => s.toggleCollapse);
  const open = activePanel !== null;

  return (
    <nav
      aria-label="우측 레일"
      className="flex flex-col items-center h-full bg-bg-subtle border-l"
      style={{ width: 'var(--rail-w)' }}
    >
      <button
        type="button"
        onClick={toggleCollapse}
        aria-expanded={open}
        aria-label={open ? '우측 패널 닫기' : '우측 패널 열기'}
        className="w-full py-2 grid place-items-center text-fg-dim hover:text-fg hover:bg-bg-input-hover"
      >
        {open ? '»' : '«'}
      </button>

      <RailItem
        panel="watchlist"
        label="관심"
        ariaLabel="관심종목 패널 토글"
        controls="right-rail-watchlist-panel"
        active={activePanel === 'watchlist'}
        onClick={() => togglePanel('watchlist')}
        icon={<HeartIcon filled={activePanel === 'watchlist'} className="w-[1.125em] h-[1.125em]" />}
      />
      <RailItem
        panel="screener"
        label="스크리너"
        ariaLabel="스크리너 패널 토글"
        controls="right-rail-screener-panel"
        active={activePanel === 'screener'}
        onClick={() => togglePanel('screener')}
        icon={<FunnelIcon filled={activePanel === 'screener'} className="w-[1.125em] h-[1.125em]" />}
      />
    </nav>
  );
}

function RailItem({
  panel, label, ariaLabel, controls, active, onClick, icon,
}: {
  panel: RailPanel; label: string; ariaLabel: string; controls: string;
  active: boolean; onClick: () => void; icon: React.ReactNode;
}) {
  // Active = tint bg + neutral text, matching NavItem (no triple-teal). The icon
  // fill (currentColor=fg) is a shape signal, not a 2nd accent.
  return (
    <button
      type="button"
      data-panel={panel}
      onClick={onClick}
      aria-pressed={active}
      aria-controls={controls}
      aria-label={ariaLabel}
      className={`w-full py-3 flex flex-col items-center gap-1 ${
        active ? 'bg-tint-selection text-fg' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
      }`}
    >
      {icon}
      <span className="text-[10px] leading-tight">{label}</span>
    </button>
  );
}
