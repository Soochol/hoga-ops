import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stageWorkspaceTransfer, consumeWorkspaceTransfer } from './workspaceTransfer';
import { WORKSPACE_STORAGE_KEY } from './workspaceKeys';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/live?code=005930');
});
afterEach(() => vi.unstubAllGlobals());

it.each(['?code=000660', '?index=KOSPI', '?view=saved'])('현재 딥링크 탭 → %s → 다음 새 탭까지 배치를 전달한다', async query => {
  vi.resetModules();
  const { useWorkspaceStore } = await import('./workspace');
  const { openWorkspaceInNewTab } = await import('../live/openWorkspaceInNewTab');
  const open = vi.fn();
  vi.stubGlobal('open', open);
  useWorkspaceStore.setState({
    windows: [{ id: 'source', kind: 'chart', group: 2,
      rect: { x: .1, y: .2, w: .6, h: .7 },
      chart: { timeframe: 'D', indicatorLegendsVisible: false },
      pinned: { code: '005930', name: '삼성전자' } }],
    zOrder: ['source'], groupSymbols: { 2: { code: '005930', name: '삼성전자' } }, pendingNormalize: false,
  });
  const sharedBefore = localStorage.getItem(WORKSPACE_STORAGE_KEY);
  openWorkspaceInNewTab('/live' + query);
  const url = open.mock.calls[0][0];
  expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener');
  expect(useWorkspaceStore.getState().windows[0].pinned).toBeDefined();
  expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(sharedBefore);

  // 새 탭은 자기 저장소가 없으며, 공유 배치 대신 전달받은 창을 복원한다.
  sessionStorage.clear();
  window.history.replaceState({}, '', url);
  vi.resetModules();
  const child = (await import('./workspace')).useWorkspaceStore;
  expect(child.getState().windows[0]).toMatchObject({
    id: 'source', group: 2, rect: { x: .1, y: .2, w: .6, h: .7 },
    chart: { timeframe: 'D', indicatorLegendsVisible: false },
  });
  expect(child.getState().windows[0].pinned).toBeUndefined();
  expect(consumeWorkspaceTransfer()).toBeNull();
  expect(JSON.parse(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)!).windows[0].id).toBe('source');

  const childNavigate = await import('../live/liveNavigate');
  childNavigate.activateLiveCode('000660', 'SK하이닉스');
  expect(child.getState().groupSymbols[2]?.code).toBe('000660');
  child.getState().setChartTimeframe('source', '5m');
  childNavigate.openLiveInNewTab({ kind: 'stock', code: '035720', label: '카카오' });
  sessionStorage.clear();
  window.history.replaceState({}, '', open.mock.calls[1][0]);
  vi.resetModules();
  const grandchild = (await import('./workspace')).useWorkspaceStore;
  expect(grandchild.getState().windows[0].chart).toMatchObject({ timeframe: '5m', indicatorLegendsVisible: false });
  expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(sharedBefore);
});

it('연속으로 연 탭마다 클릭 시점의 사본을 받는다', () => {
  const source = { windows: [{ id: 'first' }] };
  const first = stageWorkspaceTransfer('/live?code=1', source);
  source.windows[0].id = 'second';
  const second = stageWorkspaceTransfer('/live?code=2', source);
  window.history.replaceState({}, '', first);
  expect(consumeWorkspaceTransfer()).toEqual({ windows: [{ id: 'first' }] });
  window.history.replaceState({}, '', second);
  expect(consumeWorkspaceTransfer()).toEqual(source);
});

it('만료된 전달은 읽지 않고 다음 전달 시 오래된 항목을 정리한다', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const url = stageWorkspaceTransfer('/live?code=1', { windows: [] });
  now.mockReturnValue(1000 + 6 * 60 * 1000);
  stageWorkspaceTransfer('/live?code=2', { windows: [] });
  window.history.replaceState({}, '', url);
  expect(consumeWorkspaceTransfer()).toBeNull();
  expect(Object.keys(localStorage).filter(k => k.startsWith('live.workspace.transfer.'))).toHaveLength(1);
  now.mockRestore();
});

it('저장소 쓰기가 불가능하면 기존 링크로 연다', () => {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  expect(stageWorkspaceTransfer('/live?code=1', { windows: [] })).toBe('/live?code=1');
  write.mockRestore();
});
