// frontend/src/state/drawings.ts
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { Drawing, DrawingId, DrawingTool, DrawingDefaults } from '../chart/drawing/types';
import { INITIAL_DEFAULTS } from '../chart/drawing/types';
import {
  loadDrawings, saveDrawings,
  loadDefaults, saveDefaults,
  drawingScope, type DrawingSlot,
} from '../chart/drawing/persistence';
import { isMinuteTimeframe, type LiveTimeframe } from './livePage';

const PERSIST_DEBOUNCE_MS = 250;

/** Timeframe → slot. Minute frames collapse to one slot; D/W/M pass through.
 *  Lives here rather than in `chart/drawing/` so the drawing layer stays free
 *  of the /live timeframe vocabulary — it only ever sees an opaque scope. */
export function slotForTimeframe(tf: LiveTimeframe): DrawingSlot {
  return isMinuteTimeframe(tf) ? 'minute' : tf;
}

/** The store/persistence key for a chart showing `code` at `tf`. Null code
 *  (no symbol selected) has no scope — consumers gate on it. */
export function drawingScopeFor(code: string | null, tf: LiveTimeframe): string | null {
  return code == null ? null : drawingScope(code, slotForTimeframe(tf));
}

// ── Undo/Redo (ADR-0107) ─────────────────────────────────────────────────
// Snapshot history is module-level non-reactive state (mirrors pendingTimers):
// undo/redo are driven by keyboard + toast, not bound to any rendered UI, so
// keeping them out of the zustand store avoids a re-render on every mutation.
// Each entry holds the PRE-mutation array reference — free to capture because
// every mutation action immutably replaces the array, so the old reference is
// a durable past state (never mutated in place).
type HistoryOp = 'add' | 'update' | 'remove' | 'clearAll' | 'restore' | 'import';
type HistoryEntry = { items: Drawing[]; op: HistoryOp; targetId?: string; at: number };
type ScopeHistory = { undo: HistoryEntry[]; redo: HistoryEntry[] };

const histories: Map<string, ScopeHistory> = new Map();
const HISTORY_CAP = 50;
/** Consecutive `update`s to the same drawing within this window collapse into
 *  one undo step — so a select-drag (many onPointerMove updates) is a single
 *  undo, not hundreds. Each merged update extends the window, so a continuous
 *  drag stays merged; only a >500ms pause mid-drag starts a new step. */
const UPDATE_MERGE_MS = 500;

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : 0);

function historyFor(scope: string): ScopeHistory {
  let h = histories.get(scope);
  if (h == null) {
    h = { undo: [], redo: [] };
    histories.set(scope, h);
  }
  return h;
}

/** Record a forward mutation: push `preState` onto the undo stack (with
 *  same-target update merging) and clear redo. */
function recordHistory(
  scope: string,
  preState: Drawing[],
  op: HistoryOp,
  targetId?: string,
): void {
  const h = historyFor(scope);
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
export type ClearToast = { scope: string; count: number; snapshot: Drawing[] } | null;

// 키는 전부 `scope` = `${code}|${slot}` (drawingScope). 종목뿐 아니라 타임프레임
// 슬롯(분/일/주/월)까지 가르므로, 같은 종목이라도 분봉에 그린 도형은 일봉에
// 나타나지 않는다. 스토어 자료구조는 키를 해석하지 않는다 — 불투명 문자열.
type State = {
  byScope: Map<string, Drawing[]>;
  loadedScopes: Set<string>;
  activeScope: string | null;
  activeTool: DrawingTool;
  /** 선택된 드로잉 — scope 별(ADR-0119 C2c-2b 후속). 드로잉이 (종목, 슬롯)
   *  귀속이라 선택도 같은 단위여야 다른 종목·다른 봉 창끼리 선택이 경합하지
   *  않는다 (같은 scope 창끼리는 선택 공유 = 드로잉 공유와 정합). */
  selectedByScope: Map<string, DrawingId | null>;
  defaults: DrawingDefaults;
  clearToast: ClearToast;
};

type Actions = {
  setActiveScope(scope: string | null): void;
  setActiveTool(tool: DrawingTool): void;
  setSelected(scope: string, id: DrawingId | null): void;
  /** scope 의 현재 선택 — 비반응형 조회(소비자 렌더는 selectedByScope selector 직독). */
  selectedFor(scope: string): DrawingId | null;
  drawingsFor(scope: string): Drawing[];
  // 변이 op 는 호출자가 scope 를 명시한다(ADR-0119 C2c-2b) — 멀티창에서 전역
  // activeScope(마지막 마운트 창이 이김)를 경유하면 다른 창의 드로잉이 엉뚱한
  // 종목·봉에 귀속된다. add 류는 "이 차트(=이 scope)에 그린다"가 항상 호출부
  // 문맥에 있으므로 인자로 받는 편이 원천적으로 안전하다.
  add(scope: string, d: Drawing): void;
  update(scope: string, id: DrawingId, patch: Partial<Drawing>): void;
  remove(scope: string, id: DrawingId): void;
  clearAll(scope: string): void;
  /** Replace the drawing list for `scope` with `items` as a normal, undoable
   *  mutation. Used by the clearAll undo-toast (restores the pre-clear
   *  snapshot) and by import. */
  restore(scope: string, items: Drawing[]): void;
  /** Append imported drawings to `scope` with fresh ids, as a single
   *  undoable step. Returns the number appended. */
  importDrawings(scope: string, items: Drawing[]): number;
  dismissClearToast(): void;
  undo(scope: string): void;
  redo(scope: string): void;
  setDefaults(patch: Partial<DrawingDefaults>): void;
  flushPending(): void;
  __resetForTests(): void;
};

// Per-scope timer map: a single shared timer would cancel an in-flight save
// for scope A the moment the user switches to scope B and edits within the
// debounce window — A's mutation never reaches localStorage and is silently
// lost on reload. Map<scope, Timer> isolates the cancel surface to "same
// scope re-arms the debounce; different scopes coexist". This covers
// timeframe switches as well as symbol switches, since both change the scope.
const pendingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
let defaultsTimer: ReturnType<typeof setTimeout> | null = null;

export const useDrawingsStore = create<State & Actions>((set, get) => {
  const queuePersist = (scope: string | null) => {
    if (scope == null) return;
    const existing = pendingTimers.get(scope);
    if (existing != null) clearTimeout(existing);
    pendingTimers.set(scope, setTimeout(() => {
      const items = get().byScope.get(scope) ?? [];
      saveDrawings(scope, items);
      pendingTimers.delete(scope);
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
    byScope: new Map(),
    loadedScopes: new Set(),
    activeScope: null,
    activeTool: 'select',
    selectedByScope: new Map(),
    defaults: loadDefaults(),
    clearToast: null,

    setActiveScope(scope) {
      if (scope === get().activeScope) return;
      set({ activeScope: scope });
      if (scope != null && !get().loadedScopes.has(scope)) {
        const items = loadDrawings(scope);
        const byScope = new Map(get().byScope);
        byScope.set(scope, items);
        const loadedScopes = new Set(get().loadedScopes);
        loadedScopes.add(scope);
        set({ byScope, loadedScopes });
      }
    },

    setActiveTool(tool) {
      set({ activeTool: tool });
    },

    setSelected(scope, id) {
      const selectedByScope = new Map(get().selectedByScope);
      selectedByScope.set(scope, id);
      set({ selectedByScope });
    },

    selectedFor(scope) {
      return get().selectedByScope.get(scope) ?? null;
    },

    drawingsFor(scope) {
      return get().byScope.get(scope) ?? [];
    },

    add(scope, d) {
      const current = get().byScope.get(scope) ?? [];
      recordHistory(scope, current, 'add', d.id);
      const byScope = new Map(get().byScope);
      byScope.set(scope, [...current, d]);
      set({ byScope });
      queuePersist(scope);
    },

    update(scope, id, patch) {
      const current = get().byScope.get(scope) ?? [];
      recordHistory(scope, current, 'update', id);
      const next = current.map((d) => (d.id === id ? ({ ...d, ...patch } as Drawing) : d));
      const byScope = new Map(get().byScope);
      byScope.set(scope, next);
      set({ byScope });
      queuePersist(scope);

      // Drawing Defaults sync — only style fields propagate, so the last-picked
      // color / width / lineStyle / fontSize seeds the next new drawing.
      const stylePatch: Partial<DrawingDefaults> = {};
      if ('color' in patch && typeof patch.color === 'string') stylePatch.color = patch.color;
      if ('width' in patch && typeof patch.width === 'number') stylePatch.width = patch.width;
      if ('lineStyle' in patch && patch.lineStyle != null) stylePatch.lineStyle = patch.lineStyle;
      if ('fontSize' in patch && typeof (patch as { fontSize?: unknown }).fontSize === 'number') {
        stylePatch.fontSize = (patch as { fontSize: number }).fontSize;
      }
      if (Object.keys(stylePatch).length > 0) get().setDefaults(stylePatch);
    },

    setDefaults(patch) {
      set({ defaults: { ...get().defaults, ...patch } });
      queuePersistDefaults();
    },

    remove(scope, id) {
      const current = get().byScope.get(scope) ?? [];
      if (!current.some((d) => d.id === id)) return;
      recordHistory(scope, current, 'remove', id);
      const next = current.filter((d) => d.id !== id);
      const byScope = new Map(get().byScope);
      byScope.set(scope, next);
      const patch: Partial<State> = { byScope };
      if (get().selectedByScope.get(scope) === id) {
        patch.selectedByScope = new Map(get().selectedByScope).set(scope, null);
      }
      set(patch);
      queuePersist(scope);
    },

    clearAll(scope) {
      const current = get().byScope.get(scope) ?? [];
      if (current.length === 0) return; // nothing to clear → no history, no toast
      recordHistory(scope, current, 'clearAll');
      const byScope = new Map(get().byScope);
      byScope.set(scope, []);
      set({
        byScope,
        selectedByScope: new Map(get().selectedByScope).set(scope, null),
        clearToast: { scope, count: current.length, snapshot: current },
      });
      queuePersist(scope);
    },

    restore(scope, items) {
      const current = get().byScope.get(scope) ?? [];
      recordHistory(scope, current, 'restore');
      const byScope = new Map(get().byScope);
      byScope.set(scope, items);
      // 선택은 scope 별이라 복원 대상 scope 의 선택만 리셋(다른 scope 무영향).
      set({ byScope, selectedByScope: new Map(get().selectedByScope).set(scope, null) });
      queuePersist(scope);
    },

    importDrawings(scope, items) {
      if (items.length === 0) return 0;
      const current = get().byScope.get(scope) ?? [];
      recordHistory(scope, current, 'import');
      const reassigned = items.map((d) => ({ ...d, id: nanoid(8) }));
      const byScope = new Map(get().byScope);
      byScope.set(scope, [...current, ...reassigned]);
      set({ byScope });
      queuePersist(scope);
      return reassigned.length;
    },

    dismissClearToast() {
      if (get().clearToast != null) set({ clearToast: null });
    },

    undo(scope) {
      const h = histories.get(scope);
      if (h == null || h.undo.length === 0) return;
      const cur = get().byScope.get(scope) ?? [];
      const entry = h.undo.pop()!;
      h.redo.push({ items: cur, op: entry.op, targetId: entry.targetId, at: nowMs() });
      const byScope = new Map(get().byScope);
      byScope.set(scope, entry.items);
      const sel = get().selectedByScope.get(scope) ?? null;
      const stillPresent = sel != null && entry.items.some((d) => d.id === sel);
      const selectedByScope = stillPresent
        ? get().selectedByScope
        : new Map(get().selectedByScope).set(scope, null);
      set({ byScope, selectedByScope });
      queuePersist(scope);
    },

    redo(scope) {
      const h = histories.get(scope);
      if (h == null || h.redo.length === 0) return;
      const cur = get().byScope.get(scope) ?? [];
      const entry = h.redo.pop()!;
      h.undo.push({ items: cur, op: entry.op, targetId: entry.targetId, at: nowMs() });
      const byScope = new Map(get().byScope);
      byScope.set(scope, entry.items);
      const sel = get().selectedByScope.get(scope) ?? null;
      const stillPresent = sel != null && entry.items.some((d) => d.id === sel);
      const selectedByScope = stillPresent
        ? get().selectedByScope
        : new Map(get().selectedByScope).set(scope, null);
      set({ byScope, selectedByScope });
      queuePersist(scope);
    },

    flushPending() {
      // Flush ALL pending scopes, not just the most recent one — see queuePersist.
      for (const [scope, timer] of pendingTimers) {
        clearTimeout(timer);
        const items = get().byScope.get(scope) ?? [];
        saveDrawings(scope, items);
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
        byScope: new Map(),
        loadedScopes: new Set(),
        activeScope: null,
        activeTool: 'select',
        selectedByScope: new Map(),
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
