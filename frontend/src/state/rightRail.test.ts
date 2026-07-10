import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useRightRailStore } from './rightRail';

describe('rightRail store', () => {
  beforeEach(() => {
    localStorage.clear();
    useRightRailStore.setState({ activePanel: null, lastPanel: 'watchlist' });
  });

  it('togglePanel opens a panel and persists activePanel', () => {
    useRightRailStore.getState().togglePanel('watchlist');
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
    expect(JSON.parse(localStorage.getItem('rightRail.layout')!).activePanel).toBe('watchlist');
  });

  it('togglePanel on the active panel closes it (null)', () => {
    useRightRailStore.getState().togglePanel('watchlist');
    useRightRailStore.getState().togglePanel('watchlist');
    expect(useRightRailStore.getState().activePanel).toBeNull();
    expect(JSON.parse(localStorage.getItem('rightRail.layout')!).activePanel).toBeNull();
  });

  it('togglePanel switches between panels (mutually exclusive)', () => {
    useRightRailStore.getState().togglePanel('watchlist');
    useRightRailStore.getState().togglePanel('screener');
    expect(useRightRailStore.getState().activePanel).toBe('screener');
    expect(useRightRailStore.getState().lastPanel).toBe('screener');
  });

  it('toggleCollapse closes when open and reopens lastPanel when collapsed', () => {
    useRightRailStore.getState().togglePanel('screener'); // lastPanel = 'screener'
    useRightRailStore.getState().toggleCollapse();        // close
    expect(useRightRailStore.getState().activePanel).toBeNull();
    useRightRailStore.getState().toggleCollapse();        // reopen lastPanel
    expect(useRightRailStore.getState().activePanel).toBe('screener');
  });

  it('migrates legacy { panelOpen: true } to activePanel "watchlist"', async () => {
    localStorage.setItem('rightRail.layout', JSON.stringify({ panelOpen: true }));
    vi.resetModules();
    const { useRightRailStore: fresh } = await import('./rightRail');
    expect(fresh.getState().activePanel).toBe('watchlist');
  });

  it('migrates legacy { panelOpen: false } to null', async () => {
    localStorage.setItem('rightRail.layout', JSON.stringify({ panelOpen: false }));
    vi.resetModules();
    const { useRightRailStore: fresh } = await import('./rightRail');
    expect(fresh.getState().activePanel).toBeNull();
  });

  it('rejects a corrupt activePanel value → default null', async () => {
    localStorage.setItem('rightRail.layout', JSON.stringify({ activePanel: 'foo' }));
    vi.resetModules();
    const { useRightRailStore: fresh } = await import('./rightRail');
    expect(fresh.getState().activePanel).toBeNull();
  });

  it('accepts signalAlerts as a persisted panel', async () => {
    localStorage.setItem('rightRail.layout', JSON.stringify({ activePanel: 'signalAlerts' }));
    vi.resetModules();
    const { useRightRailStore: fresh } = await import('./rightRail');
    expect(fresh.getState().activePanel).toBe('signalAlerts');
  });

  it('accepts heatmap as a persisted panel', async () => {
    localStorage.setItem('rightRail.layout', JSON.stringify({ activePanel: 'heatmap' }));
    vi.resetModules();
    const { useRightRailStore: fresh } = await import('./rightRail');
    expect(fresh.getState().activePanel).toBe('heatmap');
  });
});
