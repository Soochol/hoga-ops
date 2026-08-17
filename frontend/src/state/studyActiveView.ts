/**
 * `/study` 의 활성 저장뷰 — **한 번에 하나**(ADR-0148).
 *
 * 여기 있던 것은 탭 배열이었다(`study.tabs.v1`). 탭을 없앤 뒤 남는 질문은 하나뿐이라
 * 스토어도 그 하나만 든다: **지금 어느 저장뷰를 보고 있나.**
 *
 * ## 담는 것과 안 담는 것
 *
 * - **`code` 는 필수다.** `studyWindowWorkspace.studyWindowWorkareaCode()` 가 `getState()`
 *   로 **동기 fresh 읽기**를 한다 — 새로고침 직후 `savesQuery` 가 뜨기 전에도 창이 "내
 *   종목이 뭐냐" 에 답해야 하고, 못 답하면 `useWindowViewGuard` 를 타는 디바운스/타이머
 *   콜백이 조용히 버려진다. 탭 스토어가 `code` 를 영속한 이유도 이것이었다.
 * - **`label`/`name` 도 담는다.** 헤더가 `selectedSave?.label ?? active?.label` 로 폴백하므로
 *   (`StudyPage`), 빼면 saves 도착 전 한 프레임이 `'학습뷰'` + 빈 코드로 깜빡인다.
 *   탭 시절과 달리 **가공 없이 raw 를 담는다** — 탭 칩용 `종목 · 이름 · 봉` 조합 라벨
 *   (`formatStudyTabLabel`)은 렌더할 표면이 없어져 함께 삭제됐다.
 * - **`timeframe` 은 담지 않는다.** 봉의 소유자는 차트 창이고(#1326) `ChartWindowConfig`
 *   가 `study.workspace.v1` 로 영속한다. 여기 남기면 **두 번째 진실**이 생겨 #902↔#1326
 *   의 왕복이 재발한다. 창이 없는 과도기는 저장뷰 자신의 봉이 폴백 사슬 끝에서 받는다.
 * - **`viewport` 도 담지 않는다.** 탭 시절에도 스냅샷에서 빠지는 세션 한정 값이었고,
 *   슬롯이 하나뿐이면 "이탈 시 캡처 → 복귀 시 복원" 이 성립하지 않는다(캡처한 뷰와 복원
 *   대상이 같은 뷰라는 보장이 없다). 보존하려면 `Map<viewId, …>` 가 필요한데 그건
 *   멀티 뷰 상태의 재도입이다.
 *
 * ## URL 과의 우선순위
 *
 * **`?view=` 가 여기 영속된 값을 이긴다.** 딥링크로 들어온 사용자는 그 뷰를 보려는
 * 것이지 지난번에 보던 뷰를 보려는 게 아니다. 그 규칙을 실현하는 것은 `StudyPage` 의
 * 라우트 sync 가드 3개(`initialQueryViewIdRef`/`handledQueryViewIdRef`/`routeSyncPendingRef`)
 * 이므로, 저기를 "이제 단순하니까" 접으면 이 우선순위가 조용히 뒤집힌다.
 */
import { create } from 'zustand';
import type { StudyViewListRow } from '../api/studyViews';
import { attachPersistence } from './persistentSubscriber';

const STORAGE_KEY = 'study.activeView.v1';
/** 탭 시절 저장소(ADR-0148 이전). **승계 전용** — 쓰지 않고, 지우지도 않는다. */
const LEGACY_TABS_KEY = 'study.tabs.v1';

type OpenSaveFields = Pick<StudyViewListRow, 'id' | 'code' | 'label' | 'name'>;

export type StudyActiveView = {
  viewId: string;
  code: string;
  label: string;
  name: string;
};

type StudyActiveViewSnapshot = {
  version: 1;
  view: StudyActiveView | null;
};

type StudyActiveViewStore = {
  active: StudyActiveView | null;
  /**
   * 저장뷰를 연다 — 현재 뷰를 **제자리 교체**한다.
   *
   * 탭 시절의 `openSaveInActiveTab`·`openSaveInNewTab`·`ensureQuerySeed` 셋이 여기로
   * 접혔다. "새 탭으로 열기" 가 사라졌으므로 disposition 개념도 없다(ADR-0113 §3 과 동형).
   * 멱등이다 — 같은 뷰를 두 번 열어도 상태가 같다.
   */
  openSave: (save: OpenSaveFields) => void;
  /**
   * 저장뷰가 삭제됐을 때의 폴백. 그게 활성 뷰였으면 비우고 `true`, 아니면 무변화 후 `false`.
   *
   * 탭 시절 `closeTabsByViewId` 는 "다음 활성 탭" 을 반환했지만, 단일 뷰에서 그 자리는
   * **빈 상태**다 — 사용자가 지운 직후 뜻밖의 다른 뷰가 뜨는 것보다 낫다.
   */
  clearIfView: (viewId: string) => boolean;
};

export function studyActiveViewFromSave(save: OpenSaveFields): StudyActiveView {
  return { viewId: save.id, code: save.code, label: save.label, name: save.name };
}

function isStudyActiveView(value: unknown): value is StudyActiveView {
  if (!value || typeof value !== 'object') return false;
  const view = value as Record<string, unknown>;
  return (
    typeof view.viewId === 'string'
    && typeof view.code === 'string'
    && typeof view.label === 'string'
    && typeof view.name === 'string'
  );
}

function readJson(key: string): unknown {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 탭 스냅샷(`study.tabs.v1`)에서 활성 탭 **하나만** 승계한다.
 *
 * ADR-0113 은 `/live` 에서 옛 탭 키를 그냥 버렸지만 여기서는 승계한다 — 저기는
 * `live.page.v1` 이 마지막 종목을 **독립적으로 이미 영속**하고 있었고, `/study` 에는
 * 그 이중화가 없다. 버리면 기존 사용자의 첫 진입이 빈 화면이 된다.
 *
 * 버려지는 것: 나머지 탭, 핀, 탭 순서, 탭별 봉. 전환의 일회성 비용이다.
 * `label` 은 탭 시절의 조합 문자열(`종목 · 이름 · 봉`)이라 raw 로 되돌릴 수 없지만,
 * saves 가 도착하는 즉시 덮이므로 첫 프레임에만 보인다.
 */
function migrateFromStudyTabs(): StudyActiveView | null {
  const snapshot = readJson(LEGACY_TABS_KEY) as { activeIndex?: unknown; tabs?: unknown } | null;
  if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) return null;
  const tabs = snapshot.tabs.filter((tab): tab is Record<string, unknown> => (
    !!tab && typeof tab === 'object'
    && typeof (tab as Record<string, unknown>).viewId === 'string'
    && typeof (tab as Record<string, unknown>).code === 'string'
  ));
  if (tabs.length === 0) return null;
  const rawIndex = Number.isInteger(snapshot.activeIndex) ? (snapshot.activeIndex as number) : 0;
  const index = Math.min(Math.max(0, rawIndex), tabs.length - 1);
  const tab = tabs[index];
  return {
    viewId: tab.viewId as string,
    code: tab.code as string,
    label: typeof tab.label === 'string' ? tab.label : '',
    name: typeof tab.name === 'string' ? tab.name : '',
  };
}

/** 탭 키에서 승계했는가 — `initStudyActiveViewSync` 가 즉시 1회 굳히는 데 쓴다. */
let _migratedFromTabs = false;

/** 자기 키 → (비었으면) 탭 키 승계 → `null`. */
function loadActiveView(): StudyActiveView | null {
  const own = readJson(STORAGE_KEY) as Partial<StudyActiveViewSnapshot> | null;
  if (own && 'view' in own) {
    return isStudyActiveView(own.view) ? own.view : null;
  }
  const migrated = migrateFromStudyTabs();
  if (migrated) _migratedFromTabs = true;
  return migrated;
}

export function toStudyActiveViewSnapshot(
  state: Pick<StudyActiveViewStore, 'active'>,
): StudyActiveViewSnapshot {
  return { version: 1, view: state.active };
}

export const useStudyActiveViewStore = create<StudyActiveViewStore>((set, get) => ({
  active: loadActiveView(),

  openSave: (save) => {
    set({ active: studyActiveViewFromSave(save) });
  },

  clearIfView: (viewId) => {
    if (get().active?.viewId !== viewId) return false;
    set({ active: null });
    return true;
  },
}));

let _syncDispose: (() => void) | null = null;

export function initStudyActiveViewSync(): () => void {
  if (_syncDispose) return _syncDispose;
  /**
   * 승계했으면 **즉시 새 키에 굳힌다** — `attachPersistence` 는 `store.subscribe` 라
   * 하이드레이션 초기값을 쓰지 않는다. 굳히지 않으면 사용자가 뷰를 한 번도 바꾸지
   * 않는 한 매 부팅이 옛 키(`study.tabs.v1`)에 계속 기댄다. 승계가 멱등이라 결과는
   * 같지만, 1회성이라고 적어 놓고 실제로는 상시 의존하는 상태가 남는다.
   *
   * `studyWorkspace` 하이드레이션이 레거시 시드 직후 즉시 persist 해 창 id 를
   * 고정하는 것과 같은 규율이다.
   */
  if (_migratedFromTabs) {
    _migratedFromTabs = false;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(toStudyActiveViewSnapshot(useStudyActiveViewStore.getState())),
      );
    } catch {
      // quota/SSR — attachPersistence 와 같은 무음 정책. 다음 부팅이 다시 승계한다.
    }
  }
  const unsubPersist = attachPersistence(useStudyActiveViewStore, {
    storageKey: STORAGE_KEY,
    toSnapshot: (state) => toStudyActiveViewSnapshot(state),
  });
  _syncDispose = () => {
    unsubPersist();
    _syncDispose = null;
  };
  return _syncDispose;
}
