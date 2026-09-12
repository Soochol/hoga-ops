import { beforeEach, expect, it, vi } from 'vitest';
import { WINDOW_KINDS } from './workspace';
import { windowStackOrder } from '../workspace/zOrder';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.resetModules();
});

it.each(WINDOW_KINDS)('%s 창의 항상 위는 포커스와 독립적이며 저장·복원과 해제가 가능하다', async (kind) => {
  const { useWorkspaceStore, snapshotWorkspace } = await import('./workspace');
  const top = useWorkspaceStore.getState().addWindow(kind);
  const normal = useWorkspaceStore.getState().addWindow('chart');
  useWorkspaceStore.getState().toggleAlwaysOnTop(top);
  useWorkspaceStore.getState().focusWindow(normal);
  let state = useWorkspaceStore.getState();
  expect(state.zOrder.at(-1)).toBe(normal);
  expect(windowStackOrder(state.zOrder, state.windows).at(-1)).toBe(top);
  expect(snapshotWorkspace().windows.find((w) => w.id === top)?.alwaysOnTop).toBe(true);
  vi.resetModules();
  const restored = (await import('./workspace')).useWorkspaceStore;
  expect(restored.getState().windows.find((w) => w.id === top)?.alwaysOnTop).toBe(true);
  restored.getState().toggleAlwaysOnTop(top);
  state = restored.getState();
  expect(windowStackOrder(state.zOrder, state.windows).at(-1)).toBe(normal);
});

it('항상 위 창끼리는 최근 포커스 순서를 따르고 일반 창은 그 아래에 남는다', () => {
  const windows = [{ id: 'a', alwaysOnTop: true }, { id: 'b' }, { id: 'c', alwaysOnTop: true }];
  expect(windowStackOrder(['c', 'a', 'b'], windows)).toEqual(['b', 'c', 'a']);
});
