import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';

export const FLOW_COMPARISON_MODES = ['absolute', 'relative', 'momentum'] as const;
export type FlowComparisonMode = (typeof FLOW_COMPARISON_MODES)[number];
export const MAX_FLOW_GROUPS = 6;
const STORAGE_KEY = 'heatmap.flowComparison.v1';

interface Store {
  /** null = 최초 진입 시 앞쪽 6개. [] = 사용자가 모두 해제함. */
  selectedGroupIds: string[] | null;
  mode: FlowComparisonMode;
  setSelectedGroupIds: (ids: string[]) => void;
  initializeSelectedGroupIds: (ids: string[]) => void;
  setMode: (mode: FlowComparisonMode) => void;
  hydrateFromStorage: () => void;
}

function cleanIds(ids: unknown[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, MAX_FLOW_GROUPS);
}
const stored = readJsonObject(STORAGE_KEY);

export const useHeatmapFlowPrefsStore = create<Store>((set, get) => ({
  selectedGroupIds: Array.isArray(stored.selectedGroupIds) ? cleanIds(stored.selectedGroupIds) : null,
  mode: FLOW_COMPARISON_MODES.includes(stored.mode as FlowComparisonMode) ? stored.mode as FlowComparisonMode : 'absolute',
  setSelectedGroupIds: (ids) => {
    const selectedGroupIds = cleanIds(ids);
    set({ selectedGroupIds });
    persistJson(STORAGE_KEY, { selectedGroupIds, mode: get().mode });
  },
  initializeSelectedGroupIds: (ids) => {
    if (get().selectedGroupIds === null && ids.length > 0) get().setSelectedGroupIds(ids);
  },
  setMode: (mode) => {
    if (!FLOW_COMPARISON_MODES.includes(mode)) return;
    set({ mode });
    persistJson(STORAGE_KEY, { selectedGroupIds: get().selectedGroupIds, mode });
  },
  hydrateFromStorage: () => {
    const latest = readJsonObject(STORAGE_KEY);
    // 손상되거나 사용할 수 없는 저장소로 현재 탭의 유효 선택을 지우지 않는다.
    if (Array.isArray(latest.selectedGroupIds)) {
      const ids = cleanIds(latest.selectedGroupIds);
      if (JSON.stringify(ids) !== JSON.stringify(get().selectedGroupIds)) set({ selectedGroupIds: ids });
    }
    if (FLOW_COMPARISON_MODES.includes(latest.mode as FlowComparisonMode) && latest.mode !== get().mode) {
      set({ mode: latest.mode as FlowComparisonMode });
    }
  },
}));

/** 비교 화면이 열린 다른 탭도 마지막 선택을 읽는다. 쓰기 없이 반영하여 에코를 막는다. */
export function subscribeToHeatmapFlowPrefsStorage(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    useHeatmapFlowPrefsStore.getState().hydrateFromStorage();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
