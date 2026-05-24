import { create } from 'zustand';

/**
 * Runtime layout state for /replay's Cursor Sidebar. The design token
 * `--sidebar-w` (tokens.css) seeds the default width; this store owns
 * the user-overridable runtime value and the collapsed flag.
 *
 * Persistence lives inside the store (see Task 2's subscribe block),
 * not in component useEffect, because three independent consumers
 * (Workarea, Toolbar, CollapsedSidebarHandle) share the state.
 *
 * See ADR-0022 for why we keep both the token and the store.
 */

export const SIDEBAR_PX_MIN = 240;
export const SIDEBAR_PX_MAX = 520;

const SIDEBAR_PX_FALLBACK = 320; // matches --sidebar-w base intent at default density

export function readSidebarTokenPx(): number {
  if (typeof document === 'undefined') return SIDEBAR_PX_FALLBACK;
  const root = document.documentElement;
  const raw = getComputedStyle(root).getPropertyValue('--sidebar-w').trim();
  if (raw.endsWith('px')) {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : SIDEBAR_PX_FALLBACK;
  }
  if (raw.endsWith('rem')) {
    const rem = Number.parseFloat(raw);
    const rootFontPx = Number.parseFloat(getComputedStyle(root).fontSize);
    const px = rem * rootFontPx;
    return Number.isFinite(px) && px > 0 ? px : SIDEBAR_PX_FALLBACK;
  }
  return SIDEBAR_PX_FALLBACK;
}

function clampPx(n: number): number {
  if (!Number.isFinite(n)) return SIDEBAR_PX_FALLBACK;
  return Math.min(SIDEBAR_PX_MAX, Math.max(SIDEBAR_PX_MIN, n));
}

const STORAGE_KEY = 'replay.layout';

type Persisted = { sidebarPx: number; sidebarCollapsed: boolean };

function loadPersisted(): Persisted {
  const fallback: Persisted = {
    sidebarPx: clampPx(readSidebarTokenPx()),
    sidebarCollapsed: false,
  };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return fallback;
    const obj = parsed as Record<string, unknown>;
    const px =
      typeof obj.sidebarPx === 'number' ? clampPx(obj.sidebarPx) : fallback.sidebarPx;
    const collapsed =
      typeof obj.sidebarCollapsed === 'boolean'
        ? obj.sidebarCollapsed
        : fallback.sidebarCollapsed;
    return { sidebarPx: px, sidebarCollapsed: collapsed };
  } catch {
    return fallback;
  }
}

function savePersisted(p: Persisted): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* privacy mode / quota — silently ignore */
  }
}

type ReplayLayoutState = {
  sidebarPx: number;
  sidebarCollapsed: boolean;
  setSidebarPx: (px: number) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  resetSidebar: () => void;
  __resetForTests: () => void;
};

export const useReplayLayoutStore = create<ReplayLayoutState>((set) => ({
  ...loadPersisted(),
  setSidebarPx: (px) => set({ sidebarPx: clampPx(px) }),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  resetSidebar: () =>
    set({ sidebarPx: clampPx(readSidebarTokenPx()), sidebarCollapsed: false }),
  __resetForTests: () =>
    set({ sidebarPx: clampPx(readSidebarTokenPx()), sidebarCollapsed: false }),
}));

// Persistence subscriber: writes the persisted slice on every change.
// Registered once at module load; survives HMR via zustand's stable store identity.
useReplayLayoutStore.subscribe((state) => {
  savePersisted({ sidebarPx: state.sidebarPx, sidebarCollapsed: state.sidebarCollapsed });
});
