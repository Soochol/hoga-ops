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

describe('candleTooltipEnabled 토글', () => {
  it('기본값 true', () => {
    expect(DEFAULT_PREFS.candleTooltipEnabled).toBe(true);
  });

  it('persist 된 false 를 보존', () => {
    expect(mergePrefs({ candleTooltipEnabled: false }).candleTooltipEnabled).toBe(false);
  });

  it('없으면 기본값(true) 으로 폴백', () => {
    expect(mergePrefs({}).candleTooltipEnabled).toBe(true);
  });
});

import { CHART_TOGGLES, CHART_NUMERIC_PREFS, categoryOf } from './chartPrefs';

describe('총잔량 급증 설정', () => {
  it('surgeMarkerEnabled 토글 기본 ON · category surge', () => {
    expect(DEFAULT_PREFS.surgeMarkerEnabled).toBe(true);
    const t = CHART_TOGGLES.find((t) => t.key === 'surgeMarkerEnabled');
    expect(t).toBeDefined();
    expect(categoryOf(t!)).toBe('surge');
  });

  it('surgeApproachPct(기본 95, 80–100)·surgeRearmPct(기본 85, 50–95) enabledBy surgeMarkerEnabled', () => {
    expect(DEFAULT_PREFS.surgeApproachPct).toBe(95);
    expect(DEFAULT_PREFS.surgeRearmPct).toBe(85);
    const ap = CHART_NUMERIC_PREFS.find((p) => p.key === 'surgeApproachPct');
    expect(ap?.enabledBy).toBe('surgeMarkerEnabled');
    expect(ap?.min).toBe(80);
    expect(ap?.max).toBe(100);
    const re = CHART_NUMERIC_PREFS.find((p) => p.key === 'surgeRearmPct');
    expect(re?.enabledBy).toBe('surgeMarkerEnabled');
    expect(re?.min).toBe(50);
    expect(re?.max).toBe(95);
  });

  it('persist 된 surge 값 보존 + 범위 밖은 폴백', () => {
    expect(mergePrefs({ surgeMarkerEnabled: false }).surgeMarkerEnabled).toBe(false);
    expect(mergePrefs({ surgeApproachPct: 90 }).surgeApproachPct).toBe(90);
    expect(mergePrefs({ surgeApproachPct: 999 }).surgeApproachPct).toBe(DEFAULT_PREFS.surgeApproachPct);
    expect(mergePrefs({ surgeRearmPct: 70 }).surgeRearmPct).toBe(70);
  });
});
