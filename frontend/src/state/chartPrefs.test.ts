import { describe, it, expect, beforeEach } from 'vitest';
import { useChartPrefsStore, DEFAULT_PREFS } from './chartPrefs';

describe('useChartPrefsStore', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('initializes with DEFAULT_PREFS', () => {
    const s = useChartPrefsStore.getState();
    for (const key of Object.keys(DEFAULT_PREFS) as Array<keyof typeof DEFAULT_PREFS>) {
      expect(s[key]).toEqual(DEFAULT_PREFS[key]);
    }
  });

  it('setToggle mutates the named boolean', () => {
    useChartPrefsStore.getState().setToggle('auctionWindowMask', false);
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(false);
  });

  it('setNumericPref mutates the named number', () => {
    useChartPrefsStore.getState().setNumericPref('ratioOutlierThreshold', 42);
    expect(useChartPrefsStore.getState().ratioOutlierThreshold).toBe(42);
  });

  it('resetToDefaults restores DEFAULT_PREFS', () => {
    useChartPrefsStore.getState().setToggle('auctionWindowMask', false);
    useChartPrefsStore.getState().resetToDefaults();
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(true);
  });
});

import { mergePrefs, CHART_PREFS_KEY } from './chartPrefsPersistence';

describe('chartPrefsPersistence', () => {
  it('mergePrefs ignores invalid types and falls back to DEFAULT_PREFS', () => {
    const merged = mergePrefs({ auctionWindowMask: 'not-a-bool', ratioOutlierThreshold: 999_999 });
    expect(merged.auctionWindowMask).toBe(DEFAULT_PREFS.auctionWindowMask);
    expect(merged.ratioOutlierThreshold).toBe(DEFAULT_PREFS.ratioOutlierThreshold);
  });

  it('mergePrefs accepts valid values', () => {
    const merged = mergePrefs({ auctionWindowMask: false, ratioOutlierThreshold: 50 });
    expect(merged.auctionWindowMask).toBe(false);
    expect(merged.ratioOutlierThreshold).toBe(50);
  });

  it('uses the new key, not replay.tabs.*', () => {
    expect(CHART_PREFS_KEY).toBe('hoga.chart.prefs.v1');
    expect(CHART_PREFS_KEY.includes('replay')).toBe(false);
  });
});
