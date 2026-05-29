import { create } from 'zustand';

interface State {
  cursorMs: number | null;
  setCursor: (t: number) => void;
  clearCursor: () => void;
}

/**
 * /live page hover cursor. Set on chart crosshair move, cleared on
 * mouse-leave (LiveChartRoot). LiveSidebar reads this to switch between
 * latest-tracking and spot mode. See ADR-0044.
 */
export const useLiveCursorStore = create<State>((set, get) => ({
  cursorMs: null,
  setCursor: (t) => {
    if (get().cursorMs === t) return;  // identity-stable, no-op rerender
    set({ cursorMs: t });
  },
  clearCursor: () => {
    if (get().cursorMs === null) return;
    set({ cursorMs: null });
  },
}));
