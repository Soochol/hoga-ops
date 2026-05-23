import { describe, it, expect, beforeEach } from 'vitest';
import { useTabsStore } from './tabs';

describe('useTabsStore — timeframe + prefs (Map-based, CQ1)', () => {
  beforeEach(() => {
    // Reset to a clean single-tab state with empty prefs.
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('default Timeframe is committed via setSelection', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setSelection(id, {
      code: '005930',
      fromDate: '20260512',
      toDate: '20260512',
      timeframe: '1m',
    });
    const sel = useTabsStore.getState().tabs.find((t) => t.id === id)!.selection;
    expect(sel?.timeframe).toBe('1m');
  });

  it('getPrefs returns default range mode if not set', () => {
    const id = useTabsStore.getState().tabs[0].id;
    expect(useTabsStore.getState().getPrefs(id).volumeProfileMode).toBe('range');
  });

  it('setVolumeProfileMode updates per-tab prefs', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setVolumeProfileMode(id, 'per-day');
    expect(useTabsStore.getState().getPrefs(id).volumeProfileMode).toBe('per-day');
  });

  it('prefs uses Map (not Record) — parity with bundles', () => {
    const prefs = useTabsStore.getState().prefs;
    expect(prefs).toBeInstanceOf(Map);
  });

  it('getPrefs returns default auctionWindowMask=true if not set', () => {
    const id = useTabsStore.getState().tabs[0].id;
    expect(useTabsStore.getState().getPrefs(id).auctionWindowMask).toBe(true);
  });

  it('setToggle flips a per-tab boolean toggle by key', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setToggle(id, 'auctionWindowMask', false);
    expect(useTabsStore.getState().getPrefs(id).auctionWindowMask).toBe(false);
    useTabsStore.getState().setToggle(id, 'auctionWindowMask', true);
    expect(useTabsStore.getState().getPrefs(id).auctionWindowMask).toBe(true);
  });

  it('setToggle preserves volumeProfileMode on the same tab', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setVolumeProfileMode(id, 'per-day');
    useTabsStore.getState().setToggle(id, 'auctionWindowMask', false);
    const prefs = useTabsStore.getState().getPrefs(id);
    expect(prefs.volumeProfileMode).toBe('per-day');
    expect(prefs.auctionWindowMask).toBe(false);
  });

  it('closeTab removes the closed tab from prefs Map', () => {
    const id1 = useTabsStore.getState().tabs[0].id;
    const id2 = useTabsStore.getState().newTab();
    useTabsStore.getState().setVolumeProfileMode(id2, 'per-day');
    expect(useTabsStore.getState().prefs.has(id2)).toBe(true);
    useTabsStore.getState().closeTab(id2);
    expect(useTabsStore.getState().prefs.has(id2)).toBe(false);
    // id1 prefs unchanged
    expect(useTabsStore.getState().getPrefs(id1).volumeProfileMode).toBe('range');
  });
});
