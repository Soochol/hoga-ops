import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';

const STORAGE_KEY = 'rightRail.layout';

export type RailPanel = 'watchlist' | 'screener' | 'savedViews' | 'signalAlerts';
const VALID_PANELS: readonly RailPanel[] = ['watchlist', 'screener', 'savedViews', 'signalAlerts'];

type Persisted = {
  activePanel: RailPanel | null;
};

type Store = Persisted & {
  // Which panel the chevron re-opens after a collapse. Memory-only (not
  // persisted) — after a reload it falls back to the hydrated activePanel or
  // 'watchlist'. The rail itself is fixed chrome; only the panel shows/hides.
  lastPanel: RailPanel;
  setActivePanel: (panel: RailPanel | null) => void;
  togglePanel: (panel: RailPanel) => void;
  toggleCollapse: () => void;
};

const DEFAULTS: Persisted = { activePanel: null };

function persist(state: Persisted): void {
  persistJson(STORAGE_KEY, state);
}

// Accept only the new enum shape (whitelist) OR migrate the legacy boolean
// shape ({ panelOpen: true } → 'watchlist', else → null). A corrupt/hand-edited
// value must not leak into state (e.g. activePanel: 'foo' or panelOpen: 0).
function readStorage(): Partial<Persisted> {
  const parsed = readJsonObject(STORAGE_KEY);
  if ('activePanel' in parsed) {
    const v = parsed.activePanel;
    if (v === null) return { activePanel: null };
    if (typeof v === 'string' && (VALID_PANELS as readonly string[]).includes(v)) {
      return { activePanel: v as RailPanel };
    }
    return {}; // corrupt → default
  }
  if (typeof parsed.panelOpen === 'boolean') {
    return { activePanel: parsed.panelOpen ? 'watchlist' : null };
  }
  return {};
}

// Read at module load (synchronous) so the panel's persisted state is present
// before the first route paints — no flash of the default state (ADR-0052).
const hydrated = readStorage();

export const useRightRailStore = create<Store>((set, get) => ({
  ...DEFAULTS,
  ...hydrated,
  lastPanel: hydrated.activePanel ?? 'watchlist',

  setActivePanel: (panel) => {
    const next: Persisted = { activePanel: panel };
    // Opening a panel also remembers it as the chevron's re-open target.
    set(panel ? { ...next, lastPanel: panel } : next);
    persist(next);
  },

  togglePanel: (panel) => {
    get().setActivePanel(get().activePanel === panel ? null : panel);
  },

  toggleCollapse: () => {
    const { activePanel, lastPanel } = get();
    get().setActivePanel(activePanel ? null : lastPanel);
  },
}));
