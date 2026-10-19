import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'heatmap.flowComparison.v1';
beforeEach(() => { localStorage.clear(); vi.resetModules(); });

describe('흐름 비교 설정 영속', () => {
  it('선택 그룹과 기준은 각각 바꿔도 함께 저장되고 새 로드에서 복원된다', async () => {
    const { useHeatmapFlowPrefsStore: store } = await import('./heatmapFlowPrefs');
    store.getState().setSelectedGroupIds(['b', 'a']);
    store.getState().setMode('momentum');
    vi.resetModules();
    const { useHeatmapFlowPrefsStore: fresh } = await import('./heatmapFlowPrefs');
    expect(fresh.getState()).toMatchObject({ selectedGroupIds: ['b', 'a'], mode: 'momentum' });
    fresh.getState().setSelectedGroupIds(['c']);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ selectedGroupIds: ['c'], mode: 'momentum' });
  });
  it('모두 해제한 상태는 최초 기본 선택(null)과 구분한다', async () => {
    const { useHeatmapFlowPrefsStore: store } = await import('./heatmapFlowPrefs');
    expect(store.getState().selectedGroupIds).toBeNull();
    store.getState().setSelectedGroupIds([]);
    vi.resetModules();
    const { useHeatmapFlowPrefsStore: fresh } = await import('./heatmapFlowPrefs');
    expect(fresh.getState().selectedGroupIds).toEqual([]);
  });
  it('최초 기본 선택을 저장하고 이후 폴더 순서가 바뀌어도 선택을 바꾸지 않는다', async () => {
    const { useHeatmapFlowPrefsStore: store } = await import('./heatmapFlowPrefs');
    store.getState().initializeSelectedGroupIds(['a', 'b']);
    store.getState().initializeSelectedGroupIds(['b', 'c', 'a']);
    expect(store.getState().selectedGroupIds).toEqual(['a', 'b']);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ selectedGroupIds: ['a', 'b'] });
    store.getState().setSelectedGroupIds([]);
    store.getState().initializeSelectedGroupIds(['a', 'b']);
    expect(store.getState().selectedGroupIds).toEqual([]);
  });
  it('진입 시 최신 선택을 읽고 다른 탭의 변경을 쓰기 없이 반영하며 구독 해제한다', async () => {
    const { useHeatmapFlowPrefsStore: store, subscribeToHeatmapFlowPrefsStorage } = await import('./heatmapFlowPrefs');
    store.getState().setSelectedGroupIds(['old']);
    localStorage.setItem(KEY, JSON.stringify({ selectedGroupIds: ['new', 'a'], mode: 'relative' }));
    store.getState().hydrateFromStorage();
    expect(store.getState()).toMatchObject({ selectedGroupIds: ['new', 'a'], mode: 'relative' });
    const stop = subscribeToHeatmapFlowPrefsStorage();
    localStorage.setItem(KEY, JSON.stringify({ selectedGroupIds: ['b'], mode: 'momentum' }));
    const write = vi.spyOn(Storage.prototype, 'setItem');
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
      expect(store.getState()).toMatchObject({ selectedGroupIds: ['b'], mode: 'momentum' });
      expect(write).not.toHaveBeenCalled();
      stop();
      localStorage.setItem(KEY, JSON.stringify({ selectedGroupIds: ['c'], mode: 'absolute' }));
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
      expect(store.getState().selectedGroupIds).toEqual(['b']);
    } finally { write.mockRestore(); stop(); }
  });
  it('깨진 저장값을 검증하고 중복·빈 ID 및 여섯 개 초과를 정리한다', async () => {
    localStorage.setItem(KEY, JSON.stringify({ selectedGroupIds: ['a', '', 'a', 3, 'b', 'c', 'd', 'e', 'f', 'g'], mode: 'bogus' }));
    const { useHeatmapFlowPrefsStore: store } = await import('./heatmapFlowPrefs');
    expect(store.getState()).toMatchObject({ selectedGroupIds: ['a', 'b', 'c', 'd', 'e', 'f'], mode: 'absolute' });
  });
  it('손상된 JSON이나 사용할 수 없는 저장소에서도 화면은 동작한다', async () => {
    localStorage.setItem(KEY, '{broken');
    const { useHeatmapFlowPrefsStore: store } = await import('./heatmapFlowPrefs');
    expect(store.getState().mode).toBe('absolute');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    try {
      store.getState().setSelectedGroupIds(['a']);
      expect(store.getState().selectedGroupIds).toEqual(['a']);
    } finally { spy.mockRestore(); }
  });
});
