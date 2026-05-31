import { create } from 'zustand';

const STORAGE_KEY = 'rightRail.layout';

type Persisted = {
  panelOpen: boolean;
};

type Store = Persisted & {
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
};

const DEFAULTS: Persisted = { panelOpen: false };

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
    // Accept only a real boolean — a corrupt/hand-edited value (e.g. panelOpen: 0)
    // must not leak a non-boolean into state, where `0 && <Drawer/>` would render
    // a stray "0" text node and `aria-pressed="1"` would leak to the DOM.
    const out: Partial<Persisted> = {};
    if (typeof parsed.panelOpen === 'boolean') out.panelOpen = parsed.panelOpen;
    return out;
  } catch {
    return {};
  }
}

// Read at module load (synchronous) so the panel's persisted open/closed state
// is present before the first route paints — no flash of the default state.
// The Right Rail itself is fixed chrome (always --rail-w); only the Watchlist
// Panel shows/hides, so the store owns a single boolean (ADR-0052).
export const useRightRailStore = create<Store>((set, get) => ({
  ...DEFAULTS,
  ...readStorage(),

  togglePanel: () => get().setPanelOpen(!get().panelOpen),

  setPanelOpen: (open) => {
    const next: Persisted = { panelOpen: open };
    set(next);
    persist(next);
  },
}));
