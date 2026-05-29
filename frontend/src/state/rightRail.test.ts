import { describe, it, expect, beforeEach } from 'vitest';
import { useRightRailStore } from './rightRail';

describe('rightRail store', () => {
  beforeEach(() => {
    localStorage.clear();
    useRightRailStore.setState({ panelOpen: false, railCollapsed: false });
  });

  it('togglePanel flips panelOpen and persists', () => {
    useRightRailStore.getState().togglePanel();
    expect(useRightRailStore.getState().panelOpen).toBe(true);
    expect(JSON.parse(localStorage.getItem('rightRail.layout')!).panelOpen).toBe(true);
  });

  it('opening the panel expands a collapsed rail (Panel-open ⟹ rail-expanded)', () => {
    useRightRailStore.setState({ panelOpen: false, railCollapsed: true });
    useRightRailStore.getState().setPanelOpen(true);
    expect(useRightRailStore.getState().panelOpen).toBe(true);
    expect(useRightRailStore.getState().railCollapsed).toBe(false);
  });

  it('collapsing the rail closes an open panel', () => {
    useRightRailStore.setState({ panelOpen: true, railCollapsed: false });
    useRightRailStore.getState().toggleRailCollapsed();
    expect(useRightRailStore.getState().railCollapsed).toBe(true);
    expect(useRightRailStore.getState().panelOpen).toBe(false);
  });

  it('setRailCollapsed(true) closes the panel; (false) leaves panel intact', () => {
    useRightRailStore.setState({ panelOpen: true, railCollapsed: false });
    useRightRailStore.getState().setRailCollapsed(true);
    expect(useRightRailStore.getState().panelOpen).toBe(false);
    useRightRailStore.getState().setRailCollapsed(false);
    expect(useRightRailStore.getState().panelOpen).toBe(false);
  });
});
