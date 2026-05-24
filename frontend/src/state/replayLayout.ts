import { create } from 'zustand';
import { resolveTokens } from '../util/tokens';
import { attachPersistence } from './persistentSubscriber';

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
const SIDEBAR_TOKEN_FALLBACK = '20rem'; // matches tokens.css default density

export function readSidebarTokenPx(): number {
  // util/tokens.resolveTokens owns the "getComputedStyle + trim + fallback"
  // contract for all design-token reads (chart canvas resolvers, etc.).
  // Routing through it keeps the SSR / empty-string fallback in one place.
  // This function's own responsibility is the px / rem unit parsing.
  const { sidebarW } = resolveTokens({
    sidebarW: ['--sidebar-w', SIDEBAR_TOKEN_FALLBACK],
  });
  if (sidebarW.endsWith('px')) {
    const n = Number.parseFloat(sidebarW);
    return Number.isFinite(n) && n > 0 ? n : SIDEBAR_PX_FALLBACK;
  }
  if (sidebarW.endsWith('rem')) {
    const rem = Number.parseFloat(sidebarW);
    const rootFontPx =
      typeof document !== 'undefined'
        ? Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
        : 16;
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

/** Debounced persistence + HMR dispose via the shared helper. */
const unsubscribeLayout = attachPersistence(useReplayLayoutStore, {
  storageKey: STORAGE_KEY,
  toSnapshot: (s) => ({ sidebarPx: s.sidebarPx, sidebarCollapsed: s.sidebarCollapsed }),
});

if (import.meta.hot) {
  import.meta.hot.dispose(unsubscribeLayout);
}
