import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useRightRailStore } from './rightRail';

describe('rightRail store', () => {
  beforeEach(() => {
    localStorage.clear();
    useRightRailStore.setState({ panelOpen: false });
  });

  it('togglePanel flips panelOpen and persists', () => {
    useRightRailStore.getState().togglePanel();
    expect(useRightRailStore.getState().panelOpen).toBe(true);
    expect(JSON.parse(localStorage.getItem('rightRail.layout')!).panelOpen).toBe(true);

    useRightRailStore.getState().togglePanel();
    expect(useRightRailStore.getState().panelOpen).toBe(false);
    expect(JSON.parse(localStorage.getItem('rightRail.layout')!).panelOpen).toBe(false);
  });

  it('setPanelOpen sets and persists', () => {
    useRightRailStore.getState().setPanelOpen(true);
    expect(useRightRailStore.getState().panelOpen).toBe(true);
    expect(JSON.parse(localStorage.getItem('rightRail.layout')!).panelOpen).toBe(true);
  });

  it('hydration ignores non-boolean persisted values (corrupt storage → defaults)', async () => {
    // The store reads localStorage at module init, so re-import with a fresh
    // module registry to exercise readStorage() against corrupt data.
    localStorage.setItem('rightRail.layout', JSON.stringify({ panelOpen: 0 }));
    vi.resetModules();
    const { useRightRailStore: fresh } = await import('./rightRail');
    expect(fresh.getState().panelOpen).toBe(false);
  });
});
