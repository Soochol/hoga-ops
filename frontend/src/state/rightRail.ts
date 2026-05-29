import { create } from 'zustand';

const STORAGE_KEY = 'rightRail.layout';

type Persisted = {
  panelOpen: boolean;
  railCollapsed: boolean;
};

type Store = Persisted & {
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  toggleRailCollapsed: () => void;
  setRailCollapsed: (collapsed: boolean) => void;
};

const DEFAULTS: Persisted = { panelOpen: false, railCollapsed: false };

function persist(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable (SSR, privacy mode) — silent fallback.
  }
}

function readStorage(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof parsed !== 'object' || parsed === null) return {};
    // Accept only real booleans — a corrupt/hand-edited value (e.g. panelOpen: 0)
    // must not leak a non-boolean into state, where `0 && <Drawer/>` would render
    // a stray "0" text node and `aria-pressed="1"` would leak to the DOM.
    const out: Partial<Persisted> = {};
    if (typeof parsed.panelOpen === 'boolean') out.panelOpen = parsed.panelOpen;
    if (typeof parsed.railCollapsed === 'boolean') out.railCollapsed = parsed.railCollapsed;
    return out;
  } catch {
    return {};
  }
}

// Read at module load (synchronous) so the rail's persisted state is present
// before the first route paints — no flash of the default closed state.
export const useRightRailStore = create<Store>((set, get) => ({
  ...DEFAULTS,
  ...readStorage(),

  togglePanel: () => get().setPanelOpen(!get().panelOpen),

  setPanelOpen: (open) => {
    const next: Persisted = { panelOpen: open, railCollapsed: open ? false : get().railCollapsed };
    set(next);
    persist(next);
  },

  toggleRailCollapsed: () => get().setRailCollapsed(!get().railCollapsed),

  setRailCollapsed: (collapsed) => {
    const next: Persisted = { railCollapsed: collapsed, panelOpen: collapsed ? false : get().panelOpen };
    set(next);
    persist(next);
  },
}));
