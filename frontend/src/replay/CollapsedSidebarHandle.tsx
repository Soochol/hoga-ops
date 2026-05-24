import { useReplayLayoutStore } from '../state/replayLayout';

/**
 * Floating right-edge button shown when the Cursor Sidebar is collapsed.
 * Clicking it expands the sidebar. Pairs with the Toolbar toggle as a
 * second entry point — see the 2026-05-24 Replay Sidebar Splitter spec.
 */
export default function CollapsedSidebarHandle() {
  const expand = () => useReplayLayoutStore.getState().setSidebarCollapsed(false);
  return (
    <button
      type="button"
      onClick={expand}
      aria-label="사이드바 보이기"
      aria-expanded={false}
      aria-controls="replay-sidebar"
      title="사이드바 보이기"
      className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-16 bg-bg-card border border-border-strong rounded-l text-fg-dim hover:text-accent hover:border-accent flex items-center justify-center text-xs font-mono"
    >
      ◀
    </button>
  );
}
