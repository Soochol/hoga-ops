import { describe, it, expect, beforeEach } from 'vitest';
import { useTabsStore, DEFAULT_MOVING_AVERAGES } from './tabs';

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

  it('default prefs.movingAverages has 5 entries with periods 5/10/20/60/120, all enabled', () => {
    const id = useTabsStore.getState().tabs[0].id;
    const mas = useTabsStore.getState().getPrefs(id).movingAverages;
    expect(mas).toHaveLength(5);
    expect(mas.map((m) => m.period)).toEqual([5, 10, 20, 60, 120]);
    expect(mas.every((m) => m.enabled)).toBe(true);
    // Spec consistency with the exported default.
    expect(DEFAULT_MOVING_AVERAGES.map((m) => m.period)).toEqual([5, 10, 20, 60, 120]);
  });

  it('setMovingAverage updates only the targeted slot (immutability)', () => {
    const id = useTabsStore.getState().tabs[0].id;
    const before = useTabsStore.getState().getPrefs(id).movingAverages;
    useTabsStore.getState().setMovingAverage(id, 2, { enabled: false });
    const after = useTabsStore.getState().getPrefs(id).movingAverages;
    expect(after).not.toBe(before); // new array reference
    expect(after[2]).toEqual({ period: 20, enabled: false });
    // Other slots unchanged.
    expect(after[0]).toEqual({ period: 5, enabled: true });
    expect(after[1]).toEqual({ period: 10, enabled: true });
    expect(after[3]).toEqual({ period: 60, enabled: true });
    expect(after[4]).toEqual({ period: 120, enabled: true });
  });

  it('setMovingAverage patches period while preserving enabled', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setMovingAverage(id, 0, { period: 7 });
    const mas = useTabsStore.getState().getPrefs(id).movingAverages;
    expect(mas[0]).toEqual({ period: 7, enabled: true });
  });

  it('setMovingAverage with out-of-range index is a no-op', () => {
    const id = useTabsStore.getState().tabs[0].id;
    // First materialize the prefs entry so we can compare references.
    useTabsStore.getState().setMovingAverage(id, 0, { period: 7 });
    const prefsBefore = useTabsStore.getState().prefs;
    const masBefore = useTabsStore.getState().getPrefs(id).movingAverages;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useTabsStore.getState().setMovingAverage(id, 5 as any, { period: 99 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useTabsStore.getState().setMovingAverage(id, -1 as any, { period: 99 });
    expect(useTabsStore.getState().prefs).toBe(prefsBefore);
    expect(useTabsStore.getState().getPrefs(id).movingAverages).toBe(masBefore);
  });

  it('setMovingAverage on one tab does not affect another tab', () => {
    const idA = useTabsStore.getState().tabs[0].id;
    const idB = useTabsStore.getState().newTab();
    useTabsStore.getState().setMovingAverage(idA, 1, { period: 42, enabled: false });
    const masA = useTabsStore.getState().getPrefs(idA).movingAverages;
    const masB = useTabsStore.getState().getPrefs(idB).movingAverages;
    expect(masA[1]).toEqual({ period: 42, enabled: false });
    expect(masB[1]).toEqual({ period: 10, enabled: true });
    expect(masB.map((m) => m.period)).toEqual([5, 10, 20, 60, 120]);
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
