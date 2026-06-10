import { create } from 'zustand';
import type { SortMode } from '../heatmap/heat';

export const SORT_MODES = ['change', 'manual'] as const;
const STORAGE_KEY = 'heatmap.sortMode.v1';

interface Store {
  sortMode: SortMode;
  setSortMode: (value: SortMode) => void;
}

function readStorage(): SortMode | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sortMode: string };
    return SORT_MODES.includes(parsed.sortMode as SortMode)
      ? (parsed.sortMode as SortMode) : null;
  } catch {
    return null;
  }
}

function persist(sortMode: SortMode): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ sortMode })); }
  catch { /* localStorage 미가용 — 무시 */ }
}

export const useHeatmapPrefsStore = create<Store>((set) => ({
  // 기본 manual (eng-review D2): 로드 시 안정 보드 + 사용자 큐레이션(주도주 우선)
  // 순서 유지. change(등락률↓)는 옵트인 — 그 모드에선 매 폴링 라이브 재정렬 허용.
  sortMode: readStorage() ?? 'manual',
  setSortMode: (value) => {
    if (!SORT_MODES.includes(value)) return;
    set({ sortMode: value });
    persist(value);
  },
}));
