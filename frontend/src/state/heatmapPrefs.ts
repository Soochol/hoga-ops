import { create } from 'zustand';
import type { SortMode, GroupSort } from '../heatmap/heat';
import { persistJson, readJsonObject } from './persist';

export const SORT_MODES = ['change', 'manual'] as const;
const STORAGE_KEY = 'heatmap.sortMode.v1';

export const GROUP_SORTS = ['manual', 'desc', 'asc'] as const;
const STORAGE_KEY_GROUP = 'heatmap.groupSort.v1';

interface Store {
  sortMode: SortMode;
  setSortMode: (value: SortMode) => void;
  groupSort: GroupSort;
  setGroupSort: (value: GroupSort) => void;
}

function readStorage(): SortMode | null {
  const p = readJsonObject(STORAGE_KEY);
  return SORT_MODES.includes(p.sortMode as SortMode) ? (p.sortMode as SortMode) : null;
}

function readGroupSort(): GroupSort | null {
  const p = readJsonObject(STORAGE_KEY_GROUP);
  return GROUP_SORTS.includes(p.groupSort as GroupSort) ? (p.groupSort as GroupSort) : null;
}

export const useHeatmapPrefsStore = create<Store>((set) => ({
  // 기본 manual (eng-review D2): 로드 시 안정 보드 + 사용자 큐레이션(주도주 우선)
  // 순서 유지. change(등락률↓)는 옵트인 — 그 모드에선 매 폴링 라이브 재정렬 허용.
  sortMode: readStorage() ?? 'manual',
  setSortMode: (value) => {
    if (!SORT_MODES.includes(value)) return;
    set({ sortMode: value });
    persistJson(STORAGE_KEY, { sortMode: value });
  },
  // 그룹(폴더) 정렬 — 행 정렬(sortMode)과 직교. 기본 manual = folder.order(현행 보드 순서 보존).
  groupSort: readGroupSort() ?? 'manual',
  setGroupSort: (value) => {
    if (!GROUP_SORTS.includes(value)) return;
    set({ groupSort: value });
    persistJson(STORAGE_KEY_GROUP, { groupSort: value });
  },
}));
