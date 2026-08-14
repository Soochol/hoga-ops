import { nanoid } from 'nanoid';
import { create } from 'zustand';
import { isMinuteTimeframe, type LiveTimeframe } from './livePage';
import type { StudyViewListRow } from '../api/studyViews';
import { formatStudyTabLabel } from '../studyViews/studyViewSelection';
import { attachPersistence } from './persistentSubscriber';
import { mergeTabViewportCapture, type TabViewport } from '../live/viewportAnchor';

const STORAGE_KEY = 'study.tabs.v1';

type SaveTabFields = Pick<StudyViewListRow, 'id' | 'code' | 'label' | 'name' | 'timeframe'>;

export type StudyTab = {
  id: string;
  viewId: string;
  code: string;
  label: string;
  name: string;
  timeframe: LiveTimeframe;
  viewport?: TabViewport | null;
  pinned?: boolean;
};

type StudyTabSnapshot = Omit<StudyTab, 'id' | 'viewport'>;
type StudyTabsSnapshot = {
  version: 1;
  activeIndex: number;
  tabs: StudyTabSnapshot[];
};
type OpenSaveOptions = {
  timeframeOverride?: LiveTimeframe;
};

type StudyTabsStore = {
  tabs: StudyTab[];
  activeTabId: string | null;
  openSaveInActiveTab: (save: SaveTabFields, options?: OpenSaveOptions) => void;
  openSaveInNewTab: (save: SaveTabFields, options?: OpenSaveOptions) => void;
  ensureQuerySeed: (save: SaveTabFields) => void;
  focusTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeTabsByViewId: (viewId: string) => StudyTab | null;
  reorderTabs: (from: number, to: number) => void;
  toggleTabPinned: (id: string) => void;
  updateTabTimeframe: (id: string, timeframe: LiveTimeframe) => void;
  updateTabViewport: (id: string, viewport: TabViewport | null) => void;
};

function orderPinnedFirst<T extends { pinned?: boolean }>(tabs: T[]): T[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

function samePinGroup(a: { pinned?: boolean }, b: { pinned?: boolean }): boolean {
  return Boolean(a.pinned) === Boolean(b.pinned);
}

function isStudyTabSnapshot(value: unknown): value is StudyTabSnapshot {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.viewId === 'string' &&
    typeof tab.code === 'string' &&
    typeof tab.label === 'string' &&
    typeof tab.name === 'string' &&
    typeof tab.timeframe === 'string'
  );
}

export function studyTabFromSave(save: SaveTabFields): StudyTab {
  const label = formatStudyTabLabel(save);
  return {
    id: nanoid(8),
    viewId: save.id,
    code: save.code,
    label,
    name: save.name,
    timeframe: save.timeframe,
  };
}

/**
 * 저장뷰를 탭으로 열 때 "기본 분봉" 설정을 적용한다 — **분봉 저장뷰에만.**
 *
 * `timeframeOverride` 의 출처는 `studyViewOpenPrefs`(설정 → 저장뷰 사이드 메뉴)이고
 * 그 값 집합은 `'current' | MinuteTimeframe` 이다. 즉 그 설정이 정하는 것은 **분봉
 * 저장뷰들끼리 어느 분봉으로 통일할까** 이지, 일봉 저장뷰를 분봉으로 바꿀지가 아니다.
 * #837 이 "저장된 분봉"→"설정된 분봉" 으로 옮긴 것도 그 축이었다 — 캘린더 봉 저장뷰는
 * 그 PR 당일부터 생기기 시작해서 고려 대상이 아니었다.
 *
 * 그런데 무조건 덮어쓰면 **`D` 저장뷰가 분봉으로 열린다.** 그 차이는 취향이 아니라
 * 비용이다: `studyReferenceQueryInputs` 가 D/W/M 에서 `range`·`candles` 를 꺼기 때문에
 * 일봉 화면은 스크리너 일봉 한 방(실측 7ms · 10KB)인데, 분봉으로 열리면 같은 구간의
 * 호가·사이드카·캔들 3쿼리(6.2MB)가 대신 나간다. 게다가 지표 디스크 캐시는 파일명에
 * `bucket_ms` 가 있어 **처음 보는 봉은 그 봉을 통째로 재계산**한다(실측: 5개월
 * 저장뷰 하나에 1,472 파일 = 184 거래일 × 8종, `mode=sidecar` 단독 141초).
 *
 * 그래서 캘린더 봉 저장뷰는 저장된 봉 그대로 연다.
 *
 * ⚠ **분봉 저장뷰도 이제 기본값이 "저장 봉 그대로" 다**(2026-08-14). 다만 그 판단은
 * 여기가 아니라 호출부에 있다 — `studyViewOpenPrefs` 가 `'saved'` 면 `StudyViewsDrawer`
 * 가 override 자체를 안 넘긴다. 이 함수는 "override 가 왔으면 분봉에만 적용한다" 는
 * 규칙만 지킨다. 근거(저장 봉은 캐시가 구조적으로 warm)는 그 스토어 주석에 있다.
 */
function saveWithOpenOptions(save: SaveTabFields, options?: OpenSaveOptions): SaveTabFields {
  const override = options?.timeframeOverride;
  if (!override) return save;
  if (!isMinuteTimeframe(save.timeframe)) return save;
  return { ...save, timeframe: override };
}

function retimeStudyTabLabel(tab: StudyTab, timeframe: LiveTimeframe): string {
  return formatStudyTabLabel({
    label: tab.label.split(' · ')[0] ?? tab.label,
    name: tab.name,
    timeframe,
  });
}

function loadStudyTabs(): { tabs: StudyTab[]; activeTabId: string | null } {
  if (typeof localStorage === 'undefined') return { tabs: [], activeTabId: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [], activeTabId: null };
    const snapshot = JSON.parse(raw) as Partial<StudyTabsSnapshot>;
    if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) {
      return { tabs: [], activeTabId: null };
    }
    const tabs = snapshot.tabs.filter(isStudyTabSnapshot).map((tab) => {
      const { viewport: _viewport, ...fields } = tab as StudyTabSnapshot & { viewport?: unknown };
      return {
        ...fields,
        pinned: fields.pinned === true ? true : undefined,
        id: nanoid(8),
      };
    });
    if (tabs.length === 0) return { tabs: [], activeTabId: null };
    const rawActiveIndex = Number.isInteger(snapshot.activeIndex) ? snapshot.activeIndex as number : 0;
    const activeIndex = Math.min(Math.max(0, rawActiveIndex), tabs.length - 1);
    return { tabs, activeTabId: tabs[activeIndex]?.id ?? null };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

export function toStudyTabsSnapshot(
  state: Pick<StudyTabsStore, 'tabs' | 'activeTabId'>,
): StudyTabsSnapshot {
  const activeIndex = Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeTabId));
  return {
    version: 1,
    activeIndex,
    tabs: state.tabs.map(({ id: _id, viewport: _viewport, pinned, ...tab }) => ({
      ...tab,
      ...(pinned ? { pinned: true } : {}),
    })),
  };
}

export const useStudyTabsStore = create<StudyTabsStore>((set, get) => ({
  ...loadStudyTabs(),

  openSaveInActiveTab: (save, options) => {
    const effectiveSave = saveWithOpenOptions(save, options);
    const { tabs, activeTabId } = get();
    const existing = tabs.find((tab) => tab.viewId === save.id);
    if (existing) {
      set({
        tabs: tabs.map((tab) => (tab.id === existing.id
          ? {
              ...tab,
              ...studyTabFromSave(effectiveSave),
              id: tab.id,
              viewport: tab.timeframe === effectiveSave.timeframe ? tab.viewport : null,
            }
          : tab)),
        activeTabId: existing.id,
      });
      return;
    }
    const next = studyTabFromSave(effectiveSave);
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (!active) {
      set({ tabs: [...tabs, next], activeTabId: next.id });
      return;
    }
    if (active.pinned) {
      const target = tabs.find((tab) => !tab.pinned);
      if (target) {
        set({
          tabs: tabs.map((tab) => (tab.id === target.id ? { ...next, id: target.id } : tab)),
          activeTabId: target.id,
        });
        return;
      }
      set({ tabs: orderPinnedFirst([...tabs, next]), activeTabId: next.id });
      return;
    }
    set({
      tabs: tabs.map((tab) => (tab.id === active.id ? { ...next, id: active.id } : tab)),
      activeTabId: active.id,
    });
  },

  openSaveInNewTab: (save, options) => {
    const next = studyTabFromSave(saveWithOpenOptions(save, options));
    set({ tabs: [...get().tabs, next], activeTabId: next.id });
  },

  ensureQuerySeed: (save) => {
    const existing = get().tabs.find((tab) => tab.viewId === save.id);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    get().openSaveInNewTab(save);
  },

  focusTab: (id) => {
    if (!get().tabs.some((tab) => tab.id === id)) return;
    set({ activeTabId: id });
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    if (tabs[index].pinned) return;
    const next = tabs.filter((tab) => tab.id !== id);
    if (activeTabId !== id) {
      set({ tabs: next });
      return;
    }
    const nextActiveId = next[index]?.id ?? next[index - 1]?.id ?? null;
    set({ tabs: next, activeTabId: nextActiveId });
  },

  closeTabsByViewId: (viewId) => {
    const { tabs, activeTabId } = get();
    const removedIndexes = tabs
      .map((tab, index) => (tab.viewId === viewId ? index : -1))
      .filter((index) => index !== -1);
    if (removedIndexes.length === 0) {
      return tabs.find((tab) => tab.id === activeTabId) ?? null;
    }
    const next = tabs.filter((tab) => tab.viewId !== viewId);
    const activeWasRemoved = tabs.some((tab) => tab.id === activeTabId && tab.viewId === viewId);
    if (!activeWasRemoved) {
      set({ tabs: next });
      return next.find((tab) => tab.id === activeTabId) ?? null;
    }
    const firstRemovedIndex = removedIndexes[0] ?? 0;
    const nextActive = next[firstRemovedIndex] ?? next[firstRemovedIndex - 1] ?? null;
    set({ tabs: next, activeTabId: nextActive?.id ?? null });
    return nextActive;
  },

  reorderTabs: (from, to) => {
    const { tabs } = get();
    if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length || from === to) return;
    if (!samePinGroup(tabs[from], tabs[to])) return;
    const next = tabs.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set({ tabs: next });
  },

  toggleTabPinned: (id) => {
    const { tabs } = get();
    if (!tabs.some((tab) => tab.id === id)) return;
    set({
      tabs: orderPinnedFirst(tabs.map((tab) => (
        tab.id === id ? { ...tab, pinned: tab.pinned ? undefined : true } : tab
      ))),
    });
  },

  updateTabTimeframe: (id, timeframe) => {
    const { tabs } = get();
    if (!tabs.some((tab) => tab.id === id)) return;
    set({
      tabs: tabs.map((tab) => (
        tab.id === id
          ? { ...tab, timeframe, label: retimeStudyTabLabel(tab, timeframe), viewport: null }
          : tab
      )),
    });
  },

  updateTabViewport: (id, viewport) => {
    const { tabs } = get();
    if (!tabs.some((tab) => tab.id === id)) return;
    set({ tabs: tabs.map((tab) => (tab.id === id ? { ...tab, viewport: mergeTabViewportCapture(tab.viewport, viewport) } : tab)) });
  },
}));

let _syncDispose: (() => void) | null = null;

export function initStudyTabsSync(): () => void {
  if (_syncDispose) return _syncDispose;
  const unsubPersist = attachPersistence(useStudyTabsStore, {
    storageKey: STORAGE_KEY,
    toSnapshot: (state) => toStudyTabsSnapshot(state),
  });
  _syncDispose = () => {
    unsubPersist();
    _syncDispose = null;
  };
  return _syncDispose;
}
