// frontend/src/state/drawings.ts
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type {
  Drawing, DrawingId, DrawingTool, DrawingDefaults, DrawingKind, DrawingStyle,
} from '../chart/drawing/types';
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

/** Nominal real-ms per BAR for the calendar timeframes. Used only as the
 *  FutureBand extrapolation pitch (empty band right of the last candle), where
 *  the invariant is round-trip consistency — "N bars past the last candle" ↔
 *  `lastRealMs + N × pitch` — not calendar exactness, so W=7d and M=30d are
 *  fine (there are no real sessions out there to collide with). */
const CALENDAR_BAR_MS: Record<'D' | 'W' | 'M', number> = {
  D: 86_400_000,
  W: 7 * 86_400_000,
  M: 30 * 86_400_000,
};

/** Bar pitch for the drawing layer's FutureBand at `tf`. Minute frames use the
 *  bundle's aggregated bucket; D/W/M need their own bar pitch because the
 *  bundle's `bucket_ms` stays 60 000 there (it keys the hoga range API, not the
 *  candle bars) — feeding it to the FutureBand made a whole-band drag on the
 *  daily chart span mere minutes of real time, collapsing every drawing
 *  anchored in the empty right band onto the last candle's X. */
export function drawingBarMsFor(
  tf: LiveTimeframe,
  bundleBucketMs: number | undefined,
): number | undefined {
  return isMinuteTimeframe(tf) ? bundleBucketMs : CALENDAR_BAR_MS[tf];
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

/** 되돌리기 이력을 보관할 스코프 수의 상한.
 *
 *  스코프는 `${code}|${slot}` 이라 종목을 옮겨 다니면 계속 새로 생기는데, 종전엔
 *  스코프별 undo 가 HISTORY_CAP 으로 묶여 있을 뿐 **스코프 자체를 버리는 경로가
 *  없었다** — 여러 종목에 그린 세션에서는 각 스코프가 최대 50개 스냅샷(각각 Drawing
 *  배열 전체)을 붙든 채 영구히 남는다. 이력은 애초에 비영속(새로고침하면 사라진다)
 *  이므로, 오래된 스코프의 이력을 버리는 건 새로고침과 같은 수준의 손실이다. */
const HISTORY_SCOPE_CAP = 12;

/** byScope 캐시에 남길 스코프 수의 상한 — pruneIdleEmptyScopes 참조. */
const SCOPE_CACHE_CAP = 16;

function historyFor(scope: string): ScopeHistory {
  let h = histories.get(scope);
  if (h == null) {
    h = { undo: [], redo: [] };
  } else {
    // 재삽입으로 MRU 끝으로 옮긴다 — Map 은 삽입 순서를 보존하므로 앞쪽이 LRU.
    histories.delete(scope);
  }
  histories.set(scope, h);
  for (const oldest of histories.keys()) {
    if (histories.size <= HISTORY_SCOPE_CAP) break;
    histories.delete(oldest);
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

/** Pending 확인 팝업 for `clearAll`. 진입점(메뉴 항목·Alt+C)이 둘이라 팝업 상태를
 *  메뉴 컴포넌트에 두면 메뉴가 닫힌 채 눌린 단축키가 게이트를 우회한다 — 그래서
 *  스토어가 트리거를 갖고 `DrawingClearConfirmHost` 가 표현을 갖는다(clearToast 와
 *  같은 host-owned 모델, ADR-0107). `count` 는 문구에 쓸 삭제 예정 개수. */
export type ClearConfirm = { scope: string; count: number } | null;

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
  clearConfirm: ClearConfirm;
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
  /** 확인 팝업을 띄운다 — `clearAll` 의 유일한 UI 진입로. 지울 게 없으면
   *  아무 일도 일어나지 않는다(빈 목록에 "정말 지울까요" 를 묻지 않는다). */
  requestClearAll(scope: string): void;
  /** 확인 팝업을 닫는다(취소·Escape·백드롭). 드로잉은 건드리지 않는다. */
  cancelClearAll(): void;
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
  /** Patch the SESSION-global flags (magnet / hiddenAll). Style is per-kind now
   *  and goes through `setKindStyle`. */
  setDefaults(patch: Partial<Pick<DrawingDefaults, 'magnet' | 'hiddenAll'>>): void;
  /** Patch one tool's sticky style (the per-kind last-used). */
  setKindStyle(kind: DrawingKind, patch: Partial<DrawingStyle>): void;
  /** The last-used style for `kind` (non-reactive read; used to seed new drawings). */
  styleForKind(kind: DrawingKind): DrawingStyle;
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

  /**
   * 방문만 하고 **아무것도 그리지 않은** 스코프 캐시를 상한까지 정리한다.
   *
   * byScope 는 localStorage 의 캐시라 버려도 재방문 시 setActiveScope 가 다시 읽는다.
   * 그래도 세 조건을 모두 만족하는 스코프만 버린다:
   *  - 활성 스코프가 아니다.
   *  - **저장 대기(pendingTimers)가 없다.** 이건 성능이 아니라 정확성 조건이다 —
   *    queuePersist 의 디바운스 콜백이 나중에 `byScope.get(scope) ?? []` 를 다시
   *    읽으므로, 먼저 비우면 그 콜백이 **빈 배열을 저장해 사용자의 그림을 지운다**.
   *  - 도형이 0개다. 버릴 내용이 없으니 최악의 경우가 "localStorage 재조회" 뿐이라
   *    손실이 원천적으로 불가능하다.
   *
   * 상한을 두는 이유: 매 전환마다 싹 비우면 되돌아올 때마다 재조회가 생긴다. 최근
   * 스코프는 캐시로 남기고 초과분(삽입 순서 앞쪽 = 오래된 것)만 버린다.
   */
  const pruneIdleEmptyScopes = (active: string | null) => {
    const { byScope, loadedScopes, selectedByScope } = get();
    if (byScope.size <= SCOPE_CACHE_CAP) return;
    const doomed: string[] = [];
    for (const [scope, items] of byScope) {
      if (byScope.size - doomed.length <= SCOPE_CACHE_CAP) break;
      if (scope === active || items.length > 0 || pendingTimers.has(scope)) continue;
      doomed.push(scope);
    }
    if (doomed.length === 0) return;
    const nextByScope = new Map(byScope);
    const nextLoaded = new Set(loadedScopes);
    const nextSelected = new Map(selectedByScope);
    for (const scope of doomed) {
      nextByScope.delete(scope);
      nextLoaded.delete(scope);
      nextSelected.delete(scope);
      histories.delete(scope);
    }
    set({ byScope: nextByScope, loadedScopes: nextLoaded, selectedByScope: nextSelected });
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
    clearConfirm: null,

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
      // 종목·타임프레임을 옮겨 다닌 만큼 쌓인 빈 스코프 캐시를 상한까지 회수한다.
      pruneIdleEmptyScopes(scope);
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

      // Per-kind style sync — the last-picked color / width / lineStyle (+ the
      // fontSize of a text label, fillOpacity of a rect) seeds the NEXT drawing
      // of the SAME kind only. Editing a trendline no longer recolors the next
      // rectangle. The edited drawing's kind is read from the pre-update array
      // (kind never changes on update, so `current` is fine).
      const edited = current.find((d) => d.id === id);
      if (edited != null) {
        const stylePatch: Partial<DrawingStyle> = {};
        if ('color' in patch && typeof patch.color === 'string') stylePatch.color = patch.color;
        if ('width' in patch && typeof patch.width === 'number') stylePatch.width = patch.width;
        if ('lineStyle' in patch && patch.lineStyle != null) stylePatch.lineStyle = patch.lineStyle;
        if ('fontSize' in patch && typeof (patch as { fontSize?: unknown }).fontSize === 'number') {
          stylePatch.fontSize = (patch as { fontSize: number }).fontSize;
        }
        if ('fillOpacity' in patch && typeof (patch as { fillOpacity?: unknown }).fillOpacity === 'number') {
          stylePatch.fillOpacity = (patch as { fillOpacity: number }).fillOpacity;
        }
        if (Object.keys(stylePatch).length > 0) get().setKindStyle(edited.kind, stylePatch);
      }
    },

    setDefaults(patch) {
      set({ defaults: { ...get().defaults, ...patch } });
      queuePersistDefaults();
    },

    setKindStyle(kind, patch) {
      const prev = get().defaults;
      set({
        defaults: {
          ...prev,
          styleByKind: {
            ...prev.styleByKind,
            [kind]: { ...prev.styleByKind[kind], ...patch },
          },
        },
      });
      queuePersistDefaults();
    },

    styleForKind(kind) {
      return get().defaults.styleByKind[kind];
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

    requestClearAll(scope) {
      const count = (get().byScope.get(scope) ?? []).length;
      if (count === 0) return; // 지울 게 없으면 팝업도 없다
      set({ clearConfirm: { scope, count } });
    },

    cancelClearAll() {
      if (get().clearConfirm != null) set({ clearConfirm: null });
    },

    clearAll(scope) {
      const current = get().byScope.get(scope) ?? [];
      // 확인 팝업은 이 액션의 성패와 무관하게 닫힌다 — 빈 목록으로 조기 반환해도
      // 팝업이 남으면 확인 버튼이 죽은 채로 떠 있게 된다.
      if (current.length === 0) {
        if (get().clearConfirm != null) set({ clearConfirm: null });
        return; // nothing to clear → no history, no toast
      }
      recordHistory(scope, current, 'clearAll');
      const byScope = new Map(get().byScope);
      byScope.set(scope, []);
      set({
        byScope,
        selectedByScope: new Map(get().selectedByScope).set(scope, null),
        clearToast: { scope, count: current.length, snapshot: current },
        clearConfirm: null,
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
        clearConfirm: null,
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
