import { create } from 'zustand';

interface State {
  cursorMs: number | null;
  lastCursorMs: number | null;
  setCursor: (t: number) => void;
  clearCursor: () => void;
  restoreCursor: () => void;
  resetCursor: () => void;
}

/**
 * /live page hover cursor.
 * - cursorMs: active spot timestamp shown by sidebar/legend.
 * - lastCursorMs: sticky last-valid hover timestamp for restore after pointer leave.
 * LiveSidebar reads cursorMs to switch between latest-tracking and spot mode.
 * See ADR-0044.
 */
export const useLiveCursorStore = create<State>((set, get) => ({
  cursorMs: null,
  lastCursorMs: null,
  setCursor: (t) => {
    const { cursorMs, lastCursorMs } = get();
    if (cursorMs === t && lastCursorMs === t) return; // identity-stable, no-op rerender
    set({ cursorMs: t, lastCursorMs: t });
  },
  clearCursor: () => {
    if (get().cursorMs === null) return;
    set({ cursorMs: null });
  },
  restoreCursor: () => {
    const { cursorMs, lastCursorMs } = get();
    if (cursorMs === lastCursorMs) return;
    set({ cursorMs: lastCursorMs });
  },
  resetCursor: () => {
    const { cursorMs, lastCursorMs } = get();
    if (cursorMs === null && lastCursorMs === null) return;
    set({ cursorMs: null, lastCursorMs: null });
  },
}));
