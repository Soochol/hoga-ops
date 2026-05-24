// frontend/src/state/drawings.ts
import { create } from 'zustand';
import type { Drawing, DrawingId, DrawingTool } from '../chart/drawing/types';
import { loadDrawings, saveDrawings } from '../chart/drawing/persistence';

const PERSIST_DEBOUNCE_MS = 250;

type State = {
  byCode: Map<string, Drawing[]>;
  loadedCodes: Set<string>;
  activeCode: string | null;
  activeTool: DrawingTool;
  selectedId: DrawingId | null;
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
  flushPending(): void;
  __resetForTests(): void;
};

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCode: string | null = null;

export const useDrawingsStore = create<State & Actions>((set, get) => {
  const queuePersist = (code: string | null) => {
    if (code == null) return;
    pendingCode = code;
    if (pendingTimer != null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      const items = get().byCode.get(code) ?? [];
      saveDrawings(code, items);
      pendingTimer = null;
      pendingCode = null;
    }, PERSIST_DEBOUNCE_MS);
  };

  return {
    byCode: new Map(),
    loadedCodes: new Set(),
    activeCode: null,
    activeTool: 'select',
    selectedId: null,

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
      if (pendingTimer != null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      const code = pendingCode;
      if (code == null) return;
      const items = get().byCode.get(code) ?? [];
      saveDrawings(code, items);
      pendingCode = null;
    },

    __resetForTests() {
      if (pendingTimer != null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      pendingCode = null;
      set({
        byCode: new Map(),
        loadedCodes: new Set(),
        activeCode: null,
        activeTool: 'select',
        selectedId: null,
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
