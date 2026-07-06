import { create } from 'zustand';

interface State {
  cursorMs: number | null;
  lastCursorMs: number | null;
  sidebarCursorMs: number | null;
  setCursor: (t: number) => void;
  setSidebarCursor: (t: number) => void;
  clearCursor: () => void;
  clearSidebarCursor: () => void;
  restoreCursor: () => void;
  resetCursor: () => void;
}

/**
 * /live page hover cursor.
 * - cursorMs: immediate chart/legend hover timestamp.
 * - lastCursorMs: sticky last-valid hover timestamp for restore after pointer leave.
 * - sidebarCursorMs: rate-limited cursor consumed by LiveSidebar and spot REST hooks.
 * See ADR-0044.
 */
export const useLiveCursorStore = create<State>((set, get) => ({
  cursorMs: null,
  lastCursorMs: null,
  sidebarCursorMs: null,
  setCursor: (t) => {
    const { cursorMs, lastCursorMs } = get();
    if (cursorMs === t && lastCursorMs === t) return; // identity-stable, no-op rerender
    set({ cursorMs: t, lastCursorMs: t });
  },
  setSidebarCursor: (t) => {
    if (get().sidebarCursorMs === t) return;
    set({ sidebarCursorMs: t });
  },
  clearCursor: () => {
    if (get().cursorMs === null) return;
    set({ cursorMs: null });
  },
  clearSidebarCursor: () => {
    if (get().sidebarCursorMs === null) return;
    set({ sidebarCursorMs: null });
  },
  restoreCursor: () => {
    const { cursorMs, lastCursorMs } = get();
    if (cursorMs === lastCursorMs) return;
    set({ cursorMs: lastCursorMs });
  },
  resetCursor: () => {
    const { cursorMs, lastCursorMs, sidebarCursorMs } = get();
    if (cursorMs === null && lastCursorMs === null && sidebarCursorMs === null) return;
    set({ cursorMs: null, lastCursorMs: null, sidebarCursorMs: null });
  },
}));
