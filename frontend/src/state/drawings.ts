// frontend/src/state/drawings.ts
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { Drawing, DrawingId, DrawingTool, DrawingDefaults } from '../chart/drawing/types';
import { INITIAL_DEFAULTS } from '../chart/drawing/types';
import {
  loadDrawings, saveDrawings,
  loadDefaults, saveDefaults,
} from '../chart/drawing/persistence';

const PERSIST_DEBOUNCE_MS = 250;

// ── Undo/Redo (ADR-0107) ─────────────────────────────────────────────────
// Snapshot history is module-level non-reactive state (mirrors pendingTimers):
// undo/redo are driven by keyboard + toast, not bound to any rendered UI, so
// keeping them out of the zustand store avoids a re-render on every mutation.
// Each entry holds the PRE-mutation array reference — free to capture because
// every mutation action immutably replaces the array, so the old reference is
// a durable past state (never mutated in place).
type HistoryOp = 'add' | 'update' | 'remove' | 'clearAll' | 'restore' | 'import';
type HistoryEntry = { items: Drawing[]; op: HistoryOp; targetId?: string; at: number };
type CodeHistory = { undo: HistoryEntry[]; redo: HistoryEntry[] };

const histories: Map<string, CodeHistory> = new Map();
const HISTORY_CAP = 50;
/** Consecutive `update`s to the same drawing within this window collapse into
 *  one undo step — so a select-drag (many onPointerMove updates) is a single
 *  undo, not hundreds. Each merged update extends the window, so a continuous
 *  drag stays merged; only a >500ms pause mid-drag starts a new step. */
const UPDATE_MERGE_MS = 500;

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : 0);

function historyFor(code: string): CodeHistory {
  let h = histories.get(code);
  if (h == null) {
    h = { undo: [], redo: [] };
    histories.set(code, h);
  }
  return h;
}

/** Record a forward mutation: push `preState` onto the undo stack (with
 *  same-target update merging) and clear redo. */
function recordHistory(
  code: string,
  preState: Drawing[],
  op: HistoryOp,
  targetId?: string,
): void {
  const h = historyFor(code);
  const last = h.undo[h.undo.length - 1];
  const t = nowMs();
  if (
    op === 'update' &&
    last != null &&
    last.op === 'update' &&
    last.targetId === targetId &&
    t - last.at < UPDATE_MERGE_MS
  ) {
    last.at = t; // extend the merge window; skip the push
  } else {
    h.undo.push({ items: preState, op, targetId, at: t });
    if (h.undo.length > HISTORY_CAP) h.undo.shift();
  }
  if (h.redo.length > 0) h.redo = [];
}

/** Pending undo-toast after `clearAll`. Reactive so DrawingClearToastHost can
 *  subscribe. `snapshot` is the pre-clear array (a frozen reference — the
 *  array was immutably replaced by clearAll), restored verbatim on 실행취소. */
export type ClearToast = { code: string; count: number; snapshot: Drawing[] } | null;

type State = {
  byCode: Map<string, Drawing[]>;
  loadedCodes: Set<string>;
  activeCode: string | null;
  activeTool: DrawingTool;
  selectedId: DrawingId | null;
  defaults: DrawingDefaults;
  clearToast: ClearToast;
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
  /** Replace the drawing list for `code` with `items` as a normal, undoable
   *  mutation. Used by the clearAll undo-toast (restores the pre-clear
   *  snapshot) and by import. */
  restore(code: string, items: Drawing[]): void;
  /** Append imported drawings to the active Code with fresh ids, as a single
   *  undoable step. Returns the number appended. */
  importDrawings(items: Drawing[]): number;
  dismissClearToast(): void;
  undo(): void;
  redo(): void;
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
    clearToast: null,

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
      const current = get().byCode.get(code) ?? [];
      recordHistory(code, current, 'add', d.id);
      const byCode = new Map(get().byCode);
      byCode.set(code, [...current, d]);
      set({ byCode });
      queuePersist(code);
    },

    update(id, patch) {
      const code = get().activeCode;
      if (code == null) return;
      const current = get().byCode.get(code) ?? [];
      recordHistory(code, current, 'update', id);
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
      const current = get().byCode.get(code) ?? [];
      if (!current.some((d) => d.id === id)) return;
      recordHistory(code, current, 'remove', id);
      const next = current.filter((d) => d.id !== id);
      const byCode = new Map(get().byCode);
      byCode.set(code, next);
      const selectedId = get().selectedId === id ? null : get().selectedId;
      set({ byCode, selectedId });
      queuePersist(code);
    },

    clearAll() {
      const code = get().activeCode;
      if (code == null) return;
      const current = get().byCode.get(code) ?? [];
      if (current.length === 0) return; // nothing to clear → no history, no toast
      recordHistory(code, current, 'clearAll');
      const byCode = new Map(get().byCode);
      byCode.set(code, []);
      set({
        byCode,
        selectedId: null,
        clearToast: { code, count: current.length, snapshot: current },
      });
      queuePersist(code);
    },

    restore(code, items) {
      const current = get().byCode.get(code) ?? [];
      recordHistory(code, current, 'restore');
      const byCode = new Map(get().byCode);
      byCode.set(code, items);
      // Only touch selection when restoring the active code; a toast may fire
      // for a code the user has since navigated away from.
      const patch: Partial<State> = { byCode };
      if (code === get().activeCode) patch.selectedId = null;
      set(patch);
      queuePersist(code);
    },

    importDrawings(items) {
      const code = get().activeCode;
      if (code == null || items.length === 0) return 0;
      const current = get().byCode.get(code) ?? [];
      recordHistory(code, current, 'import');
      const reassigned = items.map((d) => ({ ...d, id: nanoid(8) }));
      const byCode = new Map(get().byCode);
      byCode.set(code, [...current, ...reassigned]);
      set({ byCode });
      queuePersist(code);
      return reassigned.length;
    },

    dismissClearToast() {
      if (get().clearToast != null) set({ clearToast: null });
    },

    undo() {
      const code = get().activeCode;
      if (code == null) return;
      const h = histories.get(code);
      if (h == null || h.undo.length === 0) return;
      const cur = get().byCode.get(code) ?? [];
      const entry = h.undo.pop()!;
      h.redo.push({ items: cur, op: entry.op, targetId: entry.targetId, at: nowMs() });
      const byCode = new Map(get().byCode);
      byCode.set(code, entry.items);
      const selectedId =
        get().selectedId != null && entry.items.some((d) => d.id === get().selectedId)
          ? get().selectedId
          : null;
      set({ byCode, selectedId });
      queuePersist(code);
    },

    redo() {
      const code = get().activeCode;
      if (code == null) return;
      const h = histories.get(code);
      if (h == null || h.redo.length === 0) return;
      const cur = get().byCode.get(code) ?? [];
      const entry = h.redo.pop()!;
      h.undo.push({ items: cur, op: entry.op, targetId: entry.targetId, at: nowMs() });
      const byCode = new Map(get().byCode);
      byCode.set(code, entry.items);
      const selectedId =
        get().selectedId != null && entry.items.some((d) => d.id === get().selectedId)
          ? get().selectedId
          : null;
      set({ byCode, selectedId });
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
      histories.clear();
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
        clearToast: null,
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
