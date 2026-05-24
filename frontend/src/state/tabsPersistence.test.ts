import { describe, it, expect, beforeEach } from 'vitest';
import { STORAGE_KEY } from './tabsPersistence';

describe('tabsPersistence — module scaffold', () => {
  it('exports STORAGE_KEY = "replay.tabs.v1"', () => {
    expect(STORAGE_KEY).toBe('replay.tabs.v1');
  });
});

import { toSnapshot } from './tabsPersistence';
import type { Tab, ChartViewPrefs } from './tabs';

const defaultPrefs: ChartViewPrefs = {
  volumeProfileMode: 'range',
  movingAverages: [
    { period: 5, enabled: true },
    { period: 10, enabled: true },
    { period: 20, enabled: true },
    { period: 60, enabled: true },
    { period: 120, enabled: true },
  ],
  auctionWindowMask: true,
};

describe('toSnapshot', () => {
  it('serializes selection + prefs, excludes bundles/cursorMs/status/id', () => {
    const tab1: Tab = {
      id: 'tab-id-1',
      selection: { code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '1m' },
      cursorMs: 1_700_000_000_000,
      status: 'loaded',
      bundles: new Map([['20260512', {} as never]]),
    };
    const tab2: Tab = {
      id: 'tab-id-2',
      selection: null,
      cursorMs: null,
      status: 'empty',
      bundles: new Map(),
    };
    const prefs = new Map<string, ChartViewPrefs>([
      ['tab-id-1', { ...defaultPrefs, volumeProfileMode: 'per-day' }],
    ]);
    const snap = toSnapshot({
      tabs: [tab1, tab2],
      activeTabId: 'tab-id-2',
      prefs,
      defaultPrefs,
    });
    expect(snap.version).toBe(1);
    expect(typeof snap.savedAt).toBe('number');
    expect(snap.activeIndex).toBe(1);
    expect(snap.tabs).toHaveLength(2);
    expect(snap.tabs[0].selection).toEqual({
      code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '1m',
    });
    expect(snap.tabs[0].prefs.volumeProfileMode).toBe('per-day');
    expect(snap.tabs[1].selection).toBeNull();
    // Tabs without entries in `prefs` fall back to defaults.
    expect(snap.tabs[1].prefs.volumeProfileMode).toBe('range');
    // No bundles/cursorMs/status/id leakage.
    expect(JSON.stringify(snap)).not.toContain('cursorMs');
    expect(JSON.stringify(snap)).not.toContain('bundles');
    expect(JSON.stringify(snap)).not.toContain('tab-id-1');
  });

  it('clamps activeIndex to 0 when activeTabId not found', () => {
    const tab: Tab = { id: 'a', selection: null, cursorMs: null, status: 'empty', bundles: new Map() };
    const snap = toSnapshot({
      tabs: [tab],
      activeTabId: 'nonexistent',
      prefs: new Map(),
      defaultPrefs,
    });
    expect(snap.activeIndex).toBe(0);
  });
});
