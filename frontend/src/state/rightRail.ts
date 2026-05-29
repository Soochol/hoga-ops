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
    return (JSON.parse(raw) as Partial<Persisted>) ?? {};
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
