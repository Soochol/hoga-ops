import { beforeEach, expect, it, vi } from 'vitest';

const accountA = `acc_${'a'.repeat(32)}`, accountB = `acc_${'b'.repeat(32)}`;
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState({}, '', '/live'); vi.resetModules(); });

it('links each history to its source account, retains last account/symbol on close and restores the layout', async () => {
  const { useWorkspaceStore: store, windowSymbolOf, snapshotWorkspace } = await import('./workspace');
  const a = store.getState().addWindow('order'), b = store.getState().addWindow('order');
  store.getState().setWindowSymbol(a, { code: '007810', name: '코리아써키트' });
  store.getState().setOrderAccount(a, accountA);
  store.getState().setOrderAccount(b, accountB);
  const history = store.getState().openExecutionHistory(a, accountA)!;
  expect(store.getState().openExecutionHistory(a, accountA)).toBe(history);
  expect(store.getState().windows.find(w => w.id === history)?.executionHistory?.account).toBe(accountA);
  store.getState().setOrderAccount(b, accountA);
  expect(store.getState().windows.find(w => w.id === history)?.executionHistory?.account).toBe(accountA);
  store.getState().setOrderAccount(a, accountB);
  expect(store.getState().windows.find(w => w.id === history)?.executionHistory?.account).toBe(accountB);
  const preset = snapshotWorkspace();
  expect(preset.windows.find(w => w.id === a)?.orderAccount).toBeUndefined();
  expect(preset.windows.find(w => w.id === history)?.executionHistory?.account).toBeUndefined();
  expect(preset.windows.find(w => w.id === history)?.executionHistory?.symbol).toBeUndefined();
  expect(windowSymbolOf(store.getState(), store.getState().windows.find(w => w.id === history))).toBeNull();
  store.getState().closeWindow(a);
  const config = store.getState().windows.find(w => w.id === history)?.executionHistory;
  expect(config?.account).toBe(accountB);
  expect(config?.symbol?.code).toBe('007810');
  vi.resetModules();
  const restored = (await import('./workspace')).useWorkspaceStore.getState();
  expect(restored.windows.find(w => w.id === history)?.executionHistory).toEqual(config);
});
