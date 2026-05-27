// frontend/src/state/drawings.ts
import { create } from 'zustand';
import type { Drawing, DrawingId, DrawingTool, DrawingDefaults } from '../chart/drawing/types';
import { INITIAL_DEFAULTS } from '../chart/drawing/types';
import {
  loadDrawings, saveDrawings,
  loadDefaults, saveDefaults,
} from '../chart/drawing/persistence';

const PERSIST_DEBOUNCE_MS = 250;

type State = {
  byCode: Map<string, Drawing[]>;
  loadedCodes: Set<string>;
  activeCode: string | null;
  activeTool: DrawingTool;
  selectedId: DrawingId | null;
  defaults: DrawingDefaults;
};

type Actions = {
  setActiveCode(code: string | null): void;
  setActiveTool(tool: DrawingTool): void;
  setSelected(id: DrawingId | null): void;
  drawingsFor(code: string): Drawing[];
  add(d: Drawing): void;
  update(id: DrawingId, patch: Partial<Drawing>): void;
  remove(id: DrawingId): void;
  clearAll(): void;
  setDefaults(patch: Partial<DrawingDefaults>): void;
  flushPending(): void;
  __resetForTests(): void;
};

// Per-code timer map: a single shared timer would cancel an in-flight save
// for code A the moment the user switches to code B and edits within the
// debounce window — A's mutation never reaches localStorage and is silently
// lost on reload. Map<code, Timer> isolates the cancel surface to "same
// code re-arms the debounce; different codes coexist".
const pendingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
let defaultsTimer: ReturnType<typeof setTimeout> | null = null;

export const useDrawingsStore = create<State & Actions>((set, get) => {
  const queuePersist = (code: string | null) => {
    if (code == null) return;
    const existing = pendingTimers.get(code);
    if (existing != null) clearTimeout(existing);
    pendingTimers.set(code, setTimeout(() => {
      const items = get().byCode.get(code) ?? [];
      saveDrawings(code, items);
      pendingTimers.delete(code);
    }, PERSIST_DEBOUNCE_MS));
  };

  const queuePersistDefaults = () => {
    if (defaultsTimer != null) clearTimeout(defaultsTimer);
    defaultsTimer = setTimeout(() => {
      saveDefaults(get().defaults);
      defaultsTimer = null;
    }, PERSIST_DEBOUNCE_MS);
  };

  return {
    byCode: new Map(),
    loadedCodes: new Set(),
    activeCode: null,
    activeTool: 'select',
    selectedId: null,
    defaults: loadDefaults(),

    setActiveCode(code) {
      if (code === get().activeCode) return;
      set({ activeCode: code, selectedId: null });
      if (code != null && !get().loadedCodes.has(code)) {
        const items = loadDrawings(code);
        const byCode = new Map(get().byCode);
        byCode.set(code, items);
        const loadedCodes = new Set(get().loadedCodes);
        loadedCodes.add(code);
        set({ byCode, loadedCodes });
      }
    },

    setActiveTool(tool) {
      set({ activeTool: tool });
    },

    setSelected(id) {
      set({ selectedId: id });
    },

    drawingsFor(code) {
      return get().byCode.get(code) ?? [];
    },

    add(d) {
      const code = get().activeCode;
      if (code == null) return;
      const byCode = new Map(get().byCode);
      byCode.set(code, [...(byCode.get(code) ?? []), d]);
      set({ byCode });
      queuePersist(code);
    },

    update(id, patch) {
      const code = get().activeCode;
      if (code == null) return;
      const current = get().byCode.get(code) ?? [];
      const next = current.map((d) => (d.id === id ? ({ ...d, ...patch } as Drawing) : d));
      const byCode = new Map(get().byCode);
      byCode.set(code, next);
      set({ byCode });
      queuePersist(code);

      // Drawing Defaults sync — only style fields propagate.
      const stylePatch: Partial<DrawingDefaults> = {};
      if ('color' in patch && typeof patch.color === 'string') stylePatch.color = patch.color;
      if ('width' in patch && typeof patch.width === 'number') stylePatch.width = patch.width;
      if ('lineStyle' in patch && patch.lineStyle != null) stylePatch.lineStyle = patch.lineStyle;
      if (Object.keys(stylePatch).length > 0) get().setDefaults(stylePatch);
    },

    setDefaults(patch) {
      set({ defaults: { ...get().defaults, ...patch } });
      queuePersistDefaults();
    },

    remove(id) {
      const code = get().activeCode;
      if (code == null) return;
      const next = (get().byCode.get(code) ?? []).filter((d) => d.id !== id);
      const byCode = new Map(get().byCode);
      byCode.set(code, next);
      const selectedId = get().selectedId === id ? null : get().selectedId;
      set({ byCode, selectedId });
      queuePersist(code);
    },

    clearAll() {
      const code = get().activeCode;
      if (code == null) return;
      const byCode = new Map(get().byCode);
      byCode.set(code, []);
      set({ byCode, selectedId: null });
      queuePersist(code);
    },

    flushPending() {
      // Flush ALL pending codes, not just the most recent one — see queuePersist.
      for (const [code, timer] of pendingTimers) {
        clearTimeout(timer);
        const items = get().byCode.get(code) ?? [];
        saveDrawings(code, items);
      }
      pendingTimers.clear();
      if (defaultsTimer != null) {
        clearTimeout(defaultsTimer);
        defaultsTimer = null;
        saveDefaults(get().defaults);
      }
    },

    __resetForTests() {
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      if (defaultsTimer != null) {
        clearTimeout(defaultsTimer);
        defaultsTimer = null;
      }
      set({
        byCode: new Map(),
        loadedCodes: new Set(),
        activeCode: null,
        activeTool: 'select',
        selectedId: null,
        defaults: INITIAL_DEFAULTS,
      });
    },
  };
});

// Window listener for beforeunload — flushes pending writes synchronously
// so a user navigating away never loses a freshly-drawn shape.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    useDrawingsStore.getState().flushPending();
  });
}
