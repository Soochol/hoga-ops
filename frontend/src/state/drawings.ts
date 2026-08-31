// frontend/src/state/drawings.ts
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type {
  Drawing, DrawingId, DrawingTool, DrawingDefaults, DrawingKind, DrawingStyle,
} from '../chart/drawing/types';
import { INITIAL_DEFAULTS, isLocked, isUnlockOnlyPatch } from '../chart/drawing/types';
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
type HistoryOp =
  | 'add' | 'update' | 'remove' | 'clearAll' | 'restore' | 'import' | 'lockAll'
  // 다중 선택의 일괄 변이. 항목마다 update/remove 를 부르면 5개를 옮긴 뒤 Ctrl+Z 를
  // 5번 눌러야 한다 — setLockedAll 이 같은 이유로 이미 한 단계다.
  | 'updateMany' | 'removeMany'
  // 배열 순서 자체를 바꾸는 변이(겹침 순서). 클릭이 낱개로 오므로 병합 창이 없다.
  | 'addMany' | 'reorder';
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
  // 다중 드래그는 targetId 가 **정렬된 id 시그니처**다(updateMany 참조). 같은
  // 집합을 계속 끄는 동안에만 합쳐지고, 집합이 달라지면 새 단계가 된다 — 단건
  // update 와 정확히 같은 규칙을 키만 바꿔 적용한 것이다.
  if (
    (op === 'update' || op === 'updateMany') &&
    last != null &&
    last.op === op &&
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
export type ClearConfirm = {
  scope: string;
  /** 실제로 지워질 개수 — 잠긴 것은 빠져 있다. */
  count: number;
  /** 잠겨서 남을 개수. 0 이면 팝업이 그 문장을 아예 안 쓴다. */
  lockedCount: number;
} | null;

/** 선택 없음을 나타내는 **공유** 빈 배열.
 *
 *  셀렉터가 `s.selectedByScope.get(scope) ?? []` 를 쓰면 fallback 이 매 렌더
 *  새 배열이라 zustand 의 얕은 비교가 항상 "바뀜"으로 읽고, 구독한 컴포넌트가
 *  끝없이 리렌더한다. 상수 하나를 공유하면 참조가 안정된다. */
export const EMPTY_SELECTION: readonly DrawingId[] = [];

/** `scope` 의 선택을 `ids` 로 교체한 새 맵. 내용이 같으면 **원본을 그대로**
 *  돌려준다 — 선택이 안 바뀐 변이(예: 다른 도형 이동)가 구독자를 깨우지 않게. */
function withSelection(
  map: Map<string, readonly DrawingId[]>,
  scope: string,
  ids: readonly DrawingId[],
): Map<string, readonly DrawingId[]> {
  const cur = map.get(scope) ?? EMPTY_SELECTION;
  if (cur.length === ids.length && cur.every((id, i) => id === ids[i])) return map;
  return new Map(map).set(scope, ids.length === 0 ? EMPTY_SELECTION : ids);
}

/** 목록에서 사라진 id 를 선택에서 걷어낸 새 맵(살아남은 순서는 보존).
 *
 *  삭제·undo·redo·clearAll 이 공유하는 하나의 규칙이다. 단일 선택 시절엔 각
 *  액션이 "내 선택이 살아남았나" 를 제각기 물었고, 다중에서는 그 질문이 **부분
 *  생존**으로 바뀐다 — 3개 중 1개만 잠겨 남았다면 선택도 그 1개만 남아야 한다. */
function pruneSelection(
  map: Map<string, readonly DrawingId[]>,
  scope: string,
  items: readonly Drawing[],
): Map<string, readonly DrawingId[]> {
  const cur = map.get(scope);
  if (cur == null || cur.length === 0) return map;
  const alive = cur.filter((id) => items.some((d) => d.id === id));
  return alive.length === cur.length ? map : withSelection(map, scope, alive);
}

// 키는 전부 `scope` = `${code}|${slot}` (drawingScope). 종목뿐 아니라 타임프레임
// 슬롯(분/일/주/월)까지 가르므로, 같은 종목이라도 분봉에 그린 도형은 일봉에
// 나타나지 않는다. 스토어 자료구조는 키를 해석하지 않는다 — 불투명 문자열.
type State = {
  byScope: Map<string, Drawing[]>;
  loadedScopes: Set<string>;
  activeScope: string | null;
  activeTool: DrawingTool;
  /** 선택된 드로잉들 — scope 별(ADR-0119 C2c-2b 후속). 드로잉이 (종목, 슬롯)
   *  귀속이라 선택도 같은 단위여야 다른 종목·다른 봉 창끼리 선택이 경합하지
   *  않는다 (같은 scope 창끼리는 선택 공유 = 드로잉 공유와 정합).
   *
   *  **순서가 있는 배열이고 빈 배열이 "선택 없음"** 이다(null 아님). 마지막
   *  원소가 primary — 끝점·모서리 핸들은 단일 선택일 때만 뜨므로 실질적으로
   *  "집합이 1개일 때 그 하나"를 가리킨다. 배열인 이유는 두 가지: Set 은
   *  zustand 셀렉터의 얕은 비교와 궁합이 나쁘고(매번 새 객체), 순서가 있어야
   *  나중에 정렬·primary 규칙을 붙일 수 있다. 조회 쪽에서 멤버십이 필요하면
   *  소비자가 화면 단위로 Set 을 파생한다(프레임마다 만들지 않도록). */
  selectedByScope: Map<string, readonly DrawingId[]>;
  defaults: DrawingDefaults;
  clearToast: ClearToast;
  clearConfirm: ClearConfirm;
};

type Actions = {
  setActiveScope(scope: string | null): void;
  setActiveTool(tool: DrawingTool): void;
  /** 선택을 `id` 하나로 **교체**한다(null 이면 비운다) — 다중 선택을 접는 경로. */
  setSelected(scope: string, id: DrawingId | null): void;
  /** Shift+클릭: 이미 있으면 빼고, 없으면 끝에 붙인다(붙인 쪽이 primary). */
  toggleSelected(scope: string, id: DrawingId): void;
  /** 마퀴 커밋: `ids` 를 현재 선택에 **합집합**으로 더한다(중복 무시, 순서 보존).
   *  마퀴는 Shift 아래에서만 존재하는 제스처라 "더하기" 외의 해석이 없다. */
  addToSelection(scope: string, ids: readonly DrawingId[]): void;
  /** 선택을 `ids` 로 **교체**한다(전체 선택·복제 후 새 도형 선택). 합집합이 아니라
   *  교체인 이유: "전체 선택" 은 지금 목록과 정확히 같아야 하고, 복제 뒤에는 원본이
   *  아니라 사본이 선택돼야 한다. */
  setSelection(scope: string, ids: readonly DrawingId[]): void;
  /**
   * 모든 scope 의 선택을 비운다(도구는 건드리지 않는다). 그리기 도구로 **진입할 때**
   * 부른다 — 불변식은 "그리기 모드 ⇒ 선택 없음" 이다. select 모드에서 고른 도형이
   * 도구 전환 뒤에도 남으면, 그 헤일로가 "잡을 수 있다" 고 거짓말을 한다(그리기
   * 모드에서 누르면 새 도형이 그려진다).
   */
  clearAllSelections(): void;
  /**
   * 그리기 상태를 통째로 원상복구한다 — 도구를 select 로 되돌리고 **모든 scope 의
   * 선택을 비운다**. Escape 와 우클릭의 **유일한** 출구이며, 두 제스처가 한 액션을
   * 공유하는 것이 곧 "둘의 결과가 항상 같다" 는 보장이다(예전엔 우클릭이 도구만
   * 풀어서, 선택은 몇 번을 눌러도 남았다).
   *
   * 왜 scope 별이 아니라 전량인가: `activeTool` 이 전역 단일 필드라 그리기 모드는
   * 앱 전역 모달이다. 그 모달을 나가는 제스처가 선택만 한 창에 남겨 두면 비대칭이
   * 된다. 무엇보다 우클릭 경로(`useDrawingToolContextMenuReset`)는 화면 전역
   * 리스너라 scope 를 알 방법이 없고, `activeScope`(마지막 마운트 창이 이김)로
   * 대신하면 **엉뚱한 창의 선택만 지우고 정작 보이는 것은 남는** 간헐 버그가 된다.
   *
   * ADR-0119 C2c-2b 와 충돌하지 않는다 — 그 조항이 막는 것은 변이가 **엉뚱한
   * scope 에 귀속**되는 것이고, 균일한 해제에는 오귀속이 없다.
   */
  exitDrawingMode(): void;
  /** scope 의 현재 선택 — 비반응형 조회(소비자 렌더는 selectedByScope selector 직독).
   *  선택이 없으면 **공유 빈 배열**(EMPTY_SELECTION)을 돌려준다 — 매번 새 `[]` 를
   *  만들면 이 값을 그대로 셀렉터에 쓰는 소비자가 무한 리렌더에 빠진다. */
  selectedFor(scope: string): readonly DrawingId[];
  drawingsFor(scope: string): Drawing[];
  // 변이 op 는 호출자가 scope 를 명시한다(ADR-0119 C2c-2b) — 멀티창에서 전역
  // activeScope(마지막 마운트 창이 이김)를 경유하면 다른 창의 드로잉이 엉뚱한
  // 종목·봉에 귀속된다. add 류는 "이 차트(=이 scope)에 그린다"가 항상 호출부
  // 문맥에 있으므로 인자로 받는 편이 원천적으로 안전하다.
  add(scope: string, d: Drawing): void;
  /**
   * 잠긴 드로잉은 **이 액션이 거부한다**(ADR-0164). 유일한 예외는 키가 `locked`
   * 뿐인 패치 — 그게 잠금 해제 통로다. UI 쪽 disabled 는 감촉이고, 정확성의
   * 단일 관문은 여기다(진입점이 속성 패널·ToolCtx·키보드로 셋이라 UI 에 흩으면
   * 셋을 다 지켜야 한다).
   */
  update(scope: string, id: DrawingId, patch: Partial<Drawing>): void;
  /** 잠긴 드로잉은 거부한다 — `update` 와 같은 관문. */
  remove(scope: string, id: DrawingId): void;
  /**
   * 여러 드로잉을 **한 번의 되돌리기 단계로** 패치한다(다중 선택 이동·스타일·잠금).
   *
   * `update` 를 N번 부르는 것과 세 가지가 다르고, 그 셋이 이 액션의 존재 이유다:
   *  - 이력이 **한 단계**다. 5개를 끌고 Ctrl+Z 를 5번 누르는 일이 없다.
   *  - 드래그 병합 키가 **정렬된 id 시그니처**라, 같은 집합을 계속 끄는 동안
   *    한 단계로 합쳐진다(단건 update 의 targetId 병합과 같은 규칙).
   *  - per-kind 스타일 동기화를 **타지 않는다**. 이동 패치엔 스타일 키가 없어
   *    실해는 없지만, 배치가 그 경로를 N번 도는 것 자체가 낭비다.
   *
   * 잠긴 항목은 조용히 건너뛴다(ADR-0164) — 잠긴 것 하나 때문에 나머지 이동을
   * 통째로 거부하면 "왜 아무것도 안 움직이지" 가 된다. **단, 키가 `locked` 뿐인
   * 패치는 잠긴 항목에도 적용된다** — 단건 `update` 와 같은 예외이고, 일괄 잠금
   * 해제가 지나는 길이다.
   */
  updateMany(scope: string, patches: ReadonlyArray<{ id: DrawingId; patch: Partial<Drawing> }>): void;
  /** 여러 드로잉을 **한 번의 되돌리기 단계로** 지운다. 잠긴 것은 남는다. */
  removeMany(scope: string, ids: readonly DrawingId[]): void;
  /** 여러 드로잉을 **한 번의 되돌리기 단계로** 추가한다(다중 복제). `add` 와 같이
   *  잠금 관문이 없다 — 새로 만드는 것이라 막을 대상이 없다. */
  addMany(scope: string, items: readonly Drawing[]): void;
  /**
   * 겹침 순서를 바꾼다 — `ids` 를 배열의 맨 뒤(`'front'`) 또는 맨 앞(`'back'`)으로.
   *
   * 배열 순서가 곧 z-order 다: 렌더는 앞에서 뒤로 그리므로 **뒤쪽이 위에 보이고**,
   * `hitTestDrawings` 는 뒤에서부터 훑어 최상단을 집는다. 그래서 "맨 앞으로" 가
   * 배열의 끝으로 보내는 것이다.
   *
   * 옮겨지는 것들의 **상대 순서는 보존된다**(안정 분할). 안 그러면 함께 올린 도형들이
   * 저희끼리 순서를 바꿔 버리는데, 화면에는 아무 설명이 없다.
   *
   * 잠긴 것은 빠진다. 순서 변경은 "클릭이 어느 도형에 가는가" 를 바꾸므로 편집이다
   * (측정이 아니다 — ADR-0164 의 경계는 그 선에 있다).
   */
  reorder(scope: string, ids: readonly DrawingId[], to: 'front' | 'back'): void;
  /**
   * scope 의 모든 드로잉을 한꺼번에 잠그거나 푼다. **되돌리기 한 단계**다 —
   * 항목마다 `update` 를 부르면 20개를 잠근 뒤 Ctrl+Z 를 20번 눌러야 한다.
   * 바뀔 것이 없으면 이력도 남기지 않는다.
   */
  setLockedAll(scope: string, locked: boolean): void;
  /** 확인 팝업을 띄운다 — `clearAll` 의 유일한 UI 진입로. 지울 게 없으면
   *  아무 일도 일어나지 않는다(빈 목록에 "정말 지울까요" 를 묻지 않는다). */
  requestClearAll(scope: string): void;
  /** 확인 팝업을 닫는다(취소·Escape·백드롭). 드로잉은 건드리지 않는다. */
  cancelClearAll(): void;
  clearAll(scope: string): void;
  /** Replace the drawing list for `scope` with `items` as a normal, undoable
   *  mutation. Used by the clearAll undo-toast (restores the pre-clear
   *  snapshot) and by import.
   *
   *  잠금을 **보지 않는다**(undo/redo/import 도 같다). 이들은 배열 전체를
   *  갈아끼우는 스냅샷 이동이지 항목 편집이 아니라, 항목별 게이트가 구조적으로
   *  성립하지 않는다 — 억지로 넣으면 "되돌렸는데 일부만 돌아왔다"는 더 나쁜
   *  상태가 된다. 잠금은 편집에 대한 방어이지 시간 이동에 대한 방어가 아니다. */
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
      set({
        selectedByScope: withSelection(
          get().selectedByScope,
          scope,
          id == null ? EMPTY_SELECTION : [id],
        ),
      });
    },

    toggleSelected(scope, id) {
      const cur = get().selectedByScope.get(scope) ?? EMPTY_SELECTION;
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      set({ selectedByScope: withSelection(get().selectedByScope, scope, next) });
    },

    setSelection(scope, ids) {
      set({ selectedByScope: withSelection(get().selectedByScope, scope, ids) });
    },

    addToSelection(scope, ids) {
      if (ids.length === 0) return;
      const cur = get().selectedByScope.get(scope) ?? EMPTY_SELECTION;
      const fresh = ids.filter((id) => !cur.includes(id));
      if (fresh.length === 0) return;
      set({ selectedByScope: withSelection(get().selectedByScope, scope, [...cur, ...fresh]) });
    },

    clearAllSelections() {
      set({ selectedByScope: new Map() });
    },

    exitDrawingMode() {
      set({ activeTool: 'select', selectedByScope: new Map() });
    },

    selectedFor(scope) {
      return get().selectedByScope.get(scope) ?? EMPTY_SELECTION;
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
      // ⚠ 잠금 검사는 recordHistory **앞**이어야 한다(ADR-0164). 뒤에 두면 거부된
      // 편집마다 무의미한 undo 스냅샷이 쌓이는 데서 그치지 않고, recordHistory 가
      // redo 스택을 비우므로 **잠긴 도형에 색을 몇 번 누른 것만으로 Ctrl+Shift+Z
      // 가 죽는다** — 화면 어디에도 원인이 안 보이는 종류의 고장이다.
      if (isLocked(current.find((d) => d.id === id)) && !isUnlockOnlyPatch(patch)) return;
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
      const target = current.find((d) => d.id === id);
      // 잠금 검사가 기존 존재 검사와 같은 자리(recordHistory 앞)에 붙는다 — 사유는
      // update 의 주석과 같다.
      if (target == null || isLocked(target)) return;
      recordHistory(scope, current, 'remove', id);
      const next = current.filter((d) => d.id !== id);
      const byScope = new Map(get().byScope);
      byScope.set(scope, next);
      set({ byScope, selectedByScope: pruneSelection(get().selectedByScope, scope, next) });
      queuePersist(scope);
    },

    updateMany(scope, patches) {
      const current = get().byScope.get(scope) ?? [];
      // 잠긴 것은 여기서 빠진다 — update 와 같은 관문이되, 거부가 배치 전체가
      // 아니라 항목 단위다.
      //
      // **유일한 예외도 update 와 같다: 키가 `locked` 뿐인 패치.** 그게 일괄 잠금
      // 해제의 통로다. 다중 선택이 잠긴 도형을 담을 수 있게 된 이상 단건 update
      // 만으로는 부족하다 — 열 개를 풀려고 열 번 고르고 열 번 누르는 것이 애초에
      // 이 기능이 없애려는 수고다.
      const byId = new Map(patches.map((p) => [p.id, p.patch]));
      const applicable = current.filter(
        (d) => byId.has(d.id) && (!isLocked(d) || isUnlockOnlyPatch(byId.get(d.id)!)),
      );
      if (applicable.length === 0) return;
      // 병합 키: 실제로 적용될 id 들의 정렬 시그니처. 잠긴 것을 뺀 뒤에 만드는
      // 이유는 그것이 곧 "이 배치가 무엇을 건드리는가" 이기 때문이다.
      const signature = applicable.map((d) => d.id).sort().join(',');
      recordHistory(scope, current, 'updateMany', signature);
      // 무엇을 적용할지는 `applicable` 이 이미 정했다. 여기서 조건을 다시 쓰면
      // 두 곳이 갈릴 수 있다 — 실제로 갈렸다(필터에 잠금 해제 예외를 넣고 이쪽을
      // 빠뜨려서, 일괄 해제가 이력만 남기고 아무것도 바꾸지 않았다).
      const applicableIds = new Set(applicable.map((d) => d.id));
      const next = current.map((d) =>
        applicableIds.has(d.id) ? ({ ...d, ...byId.get(d.id) } as Drawing) : d,
      );
      const byScope = new Map(get().byScope);
      byScope.set(scope, next);
      set({ byScope });
      queuePersist(scope);
    },

    removeMany(scope, ids) {
      const current = get().byScope.get(scope) ?? [];
      const doomed = new Set(
        current.filter((d) => ids.includes(d.id) && !isLocked(d)).map((d) => d.id),
      );
      // 지울 게 하나도 없으면 이력도 남기지 않는다 — 빈 undo 단계는 redo 스택까지
      // 비우므로 무해하지 않다(setLockedAll 주석과 같은 사유).
      if (doomed.size === 0) return;
      recordHistory(scope, current, 'removeMany', [...doomed].sort().join(','));
      const next = current.filter((d) => !doomed.has(d.id));
      const byScope = new Map(get().byScope);
      byScope.set(scope, next);
      set({ byScope, selectedByScope: pruneSelection(get().selectedByScope, scope, next) });
      queuePersist(scope);
    },

    addMany(scope, items) {
      if (items.length === 0) return;
      const current = get().byScope.get(scope) ?? [];
      recordHistory(scope, current, 'addMany', items.map((d) => d.id).sort().join(','));
      const byScope = new Map(get().byScope);
      byScope.set(scope, [...current, ...items]);
      set({ byScope });
      queuePersist(scope);
    },

    reorder(scope, ids, to) {
      const current = get().byScope.get(scope) ?? [];
      const moving = new Set(
        current.filter((d) => ids.includes(d.id) && !isLocked(d)).map((d) => d.id),
      );
      if (moving.size === 0) return;
      // 이미 그 끝에 몰려 있으면 아무 일도 하지 않는다 — 빈 undo 단계는 redo 스택을
      // 비우므로 무해하지 않다(setLockedAll 과 같은 사유).
      const tailIsAllMoving = (arr: readonly Drawing[]) =>
        arr.slice(arr.length - moving.size).every((d) => moving.has(d.id));
      const headIsAllMoving = (arr: readonly Drawing[]) =>
        arr.slice(0, moving.size).every((d) => moving.has(d.id));
      if (to === 'front' ? tailIsAllMoving(current) : headIsAllMoving(current)) return;
      // 안정 분할 — 양쪽 다 원래 순서를 지킨다.
      const moved = current.filter((d) => moving.has(d.id));
      const rest = current.filter((d) => !moving.has(d.id));
      recordHistory(scope, current, 'reorder', [...moving].sort().join(','));
      const byScope = new Map(get().byScope);
      byScope.set(scope, to === 'front' ? [...rest, ...moved] : [...moved, ...rest]);
      set({ byScope });
      queuePersist(scope);
    },

    setLockedAll(scope, locked) {
      const current = get().byScope.get(scope) ?? [];
      // 이미 전부 그 상태면 아무 일도 하지 않는다 — 빈 undo 단계를 만들지 않기
      // 위해서다(redo 스택까지 비운다, ADR-0164).
      if (current.length === 0 || current.every((d) => isLocked(d) === locked)) return;
      recordHistory(scope, current, 'lockAll');
      const next = current.map((d) => {
        if (isLocked(d) === locked) return d;
        if (locked) return { ...d, locked: true } as Drawing;
        // 해제는 필드를 지운다 — 부재가 곧 "잠금 없음" 이라(스키마의 표현),
        // `locked: false` 를 남기면 같은 뜻을 두 가지로 저장하게 된다.
        const { locked: _drop, ...rest } = d;
        void _drop;
        return rest as Drawing;
      });
      const byScope = new Map(get().byScope);
      byScope.set(scope, next);
      set({ byScope });
      queuePersist(scope);
    },

    requestClearAll(scope) {
      const items = get().byScope.get(scope) ?? [];
      // 세는 대상은 **실제로 지워질 것**이다. 잠긴 것까지 세면 팝업이 "5개가
      // 삭제됩니다" 라 해 놓고 3개만 지우는 거짓말이 된다.
      const count = items.filter((d) => !isLocked(d)).length;
      if (count === 0) return; // 지울 게 없으면 팝업도 없다(전부 잠긴 경우 포함)
      set({ clearConfirm: { scope, count, lockedCount: items.length - count } });
    },

    cancelClearAll() {
      if (get().clearConfirm != null) set({ clearConfirm: null });
    },

    clearAll(scope) {
      const current = get().byScope.get(scope) ?? [];
      // 잠긴 것은 남는다 — "지워지지 않는다"의 문자 그대로다(ADR-0164).
      const survivors = current.filter((d) => isLocked(d));
      const removedCount = current.length - survivors.length;
      // 확인 팝업은 이 액션의 성패와 무관하게 닫힌다 — 빈 목록으로 조기 반환해도
      // 팝업이 남으면 확인 버튼이 죽은 채로 떠 있게 된다.
      if (removedCount === 0) {
        if (get().clearConfirm != null) set({ clearConfirm: null });
        return; // nothing to clear → no history, no toast
      }
      recordHistory(scope, current, 'clearAll');
      const byScope = new Map(get().byScope);
      byScope.set(scope, survivors);
      // 선택 해제는 **지워진 경우에만** — 잠겨서 살아남은 도형이 선택돼 있었다면
      // 그 선택은 유효하다. 그리고 그 선택이 곧 속성 패널이고, 패널의 자물쇠가
      // 잠금 해제의 유일한 경로다.
      set({
        byScope,
        selectedByScope: pruneSelection(get().selectedByScope, scope, survivors),
        // snapshot 은 지운 것만이 아니라 **지우기 직전 전체**다. 실행취소는 배열을
        // 통째로 갈아끼우므로(restore) 살아남은 잠긴 도형이 중복 부활하지 않는다.
        clearToast: { scope, count: removedCount, snapshot: current },
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
      set({ byScope, selectedByScope: withSelection(get().selectedByScope, scope, EMPTY_SELECTION) });
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
      set({
        byScope,
        selectedByScope: pruneSelection(get().selectedByScope, scope, entry.items),
      });
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
      set({
        byScope,
        selectedByScope: pruneSelection(get().selectedByScope, scope, entry.items),
      });
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
