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

import { validateSelection, mergePrefs } from './tabsPersistence';

describe('validateSelection', () => {
  it('returns the value when all fields valid', () => {
    const sel = { code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '1m' };
    expect(validateSelection(sel)).toEqual(sel);
  });
  it('returns null for null input', () => {
    expect(validateSelection(null)).toBeNull();
  });
  it('returns null when code is not 6 digits', () => {
    expect(validateSelection({ code: '5930', fromDate: '20260512', toDate: '20260512', timeframe: '1m' })).toBeNull();
  });
  it('returns null when date is not 8 digits', () => {
    expect(validateSelection({ code: '005930', fromDate: '2026-05-12', toDate: '20260512', timeframe: '1m' })).toBeNull();
  });
  it('returns null when timeframe is not in TIMEFRAME_LABELS', () => {
    expect(validateSelection({ code: '005930', fromDate: '20260512', toDate: '20260512', timeframe: '99m' })).toBeNull();
  });
  it('returns null for non-object input', () => {
    expect(validateSelection('whatever' as unknown)).toBeNull();
    expect(validateSelection(undefined as unknown)).toBeNull();
  });
});

describe('mergePrefs', () => {
  it('returns defaults when given an empty object', () => {
    expect(mergePrefs({}, defaultPrefs)).toEqual(defaultPrefs);
  });
  it('overrides known scalar keys', () => {
    const merged = mergePrefs({ volumeProfileMode: 'per-day', auctionWindowMask: false }, defaultPrefs);
    expect(merged.volumeProfileMode).toBe('per-day');
    expect(merged.auctionWindowMask).toBe(false);
  });
  it('ignores unknown volumeProfileMode value', () => {
    const merged = mergePrefs({ volumeProfileMode: 'galaxy' as never }, defaultPrefs);
    expect(merged.volumeProfileMode).toBe('range');
  });
  it('ignores non-boolean auctionWindowMask', () => {
    const merged = mergePrefs({ auctionWindowMask: 'yes' as never }, defaultPrefs);
    expect(merged.auctionWindowMask).toBe(true);
  });
  it('replaces movingAverages wholesale when length differs from default', () => {
    const merged = mergePrefs(
      { movingAverages: [{ period: 7, enabled: true }] as never },
      defaultPrefs,
    );
    expect(merged.movingAverages).toEqual(defaultPrefs.movingAverages);
  });
  it('replaces movingAverages wholesale when an element is malformed', () => {
    const broken = defaultPrefs.movingAverages.map((m, i) =>
      i === 0 ? ({ period: 'x', enabled: true } as never) : m,
    );
    const merged = mergePrefs({ movingAverages: broken }, defaultPrefs);
    expect(merged.movingAverages).toEqual(defaultPrefs.movingAverages);
  });
  it('accepts a fully-shaped movingAverages array', () => {
    const custom = defaultPrefs.movingAverages.map((m) => ({ ...m, enabled: false }));
    const merged = mergePrefs({ movingAverages: custom }, defaultPrefs);
    expect(merged.movingAverages).toEqual(custom);
  });
  it('drops unknown keys silently', () => {
    const merged = mergePrefs({ futureKey: 42 } as never, defaultPrefs);
    expect((merged as Record<string, unknown>).futureKey).toBeUndefined();
  });
});
