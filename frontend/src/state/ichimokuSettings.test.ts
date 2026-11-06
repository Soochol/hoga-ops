import { beforeEach, describe, expect, it } from 'vitest';
import { useLivePageStore } from './livePage';
import { FACTORY_INDICATOR_SETTINGS, normalizeIndicatorsV2, resolveIndicatorSettings } from './indicatorSettingsV2';
import { flagRemovalPatches, INDICATOR_OPS } from './indicatorOps';
import { captureIndicatorSettings, instanceSettings, makeIndicatorInstance } from './indicatorInstances';
import { DEFAULT_PREFS } from './chartPrefs';
import { indicatorInstanceApplicable } from '../live/indicators/indicatorInstancePanes';
import { indicatorResetPatch } from '../live/indicators/indicatorReset';

describe('Ichimoku scoped settings', () => {
  beforeEach(() => { localStorage.clear(); useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: '1m' }); });
  it('persists bounded parameters and independent cloud visibility in the current timeframe', () => {
    useLivePageStore.getState().setIchimokuEnabled(true);
    useLivePageStore.getState().setIchimokuSettings({ ichimokuConversionPeriod: 3, ichimokuDisplacement: 0, ichimokuCloudVisible: false, ichimokuCloudOpacity: .42 });
    const saved = normalizeIndicatorsV2(JSON.parse(localStorage.getItem('live.indicators.v2')!));
    expect(resolveIndicatorSettings(saved.byTimeframe, '1m')).toMatchObject({ ichimokuEnabled: true, ichimokuConversionPeriod: 3, ichimokuDisplacement: 0, ichimokuCloudVisible: false, ichimokuCloudOpacity: .42 });
    expect(resolveIndicatorSettings(saved.byTimeframe, 'D').ichimokuEnabled).toBe(false);
    const corrupt = normalizeIndicatorsV2({ byTimeframe: { minute: { ichimokuEnabled: true, ichimokuConversionPeriod: -9, ichimokuBasePeriod: Infinity, ichimokuDisplacement: 1e100, ichimokuCloudOpacity: 2, ichimokuLaggingColor: 'invalid' } } });
    expect(resolveIndicatorSettings(corrupt.byTimeframe, '1m')).toMatchObject({ ichimokuConversionPeriod: 1, ichimokuBasePeriod: 26, ichimokuDisplacement: 500, ichimokuCloudOpacity: 1, ichimokuLaggingColor: '#10B981' });
    expect(INDICATOR_OPS.setIchimokuSettings(FACTORY_INDICATOR_SETTINGS, { ichimokuDisplacement: NaN })).toBeNull();
    expect(INDICATOR_OPS.setIchimokuSettings(FACTORY_INDICATOR_SETTINGS, { ichimokuCloudPositiveColor: 'bad' })).toBeNull();
  });
  it('owns all scalar/line fields and delete/undo preserves sibling indicators', () => {
    const cur = { ...FACTORY_INDICATOR_SETTINGS, ichimokuEnabled: true, ichimokuHidden: true, ichimokuBasePeriod: 31, ichimokuCloudOpacity: .4, bollingerEnabled: true, indicatorLineVisibility: { ichimokuLeadingA: false as const, bollingerUpper: false as const } };
    const captured = captureIndicatorSettings('ichimoku', cur);
    expect(captured.indicatorLineVisibility).toEqual({ ichimokuLeadingA: false });
    expect(captured).not.toHaveProperty('bollingerEnabled');
    const instance = makeIndicatorInstance('ichimoku', cur, DEFAULT_PREFS);
    expect(instanceSettings({ ...cur, ichimokuBasePeriod: 9 }, instance).ichimokuBasePeriod).toBe(31);
    const removal = flagRemovalPatches(cur, 'ichimoku', FACTORY_INDICATOR_SETTINGS);
    expect({ ...cur, ...removal.apply }).toMatchObject({ ichimokuEnabled: false, ichimokuHidden: false, ichimokuBasePeriod: 26, ichimokuCloudOpacity: .16, bollingerEnabled: true });
    expect({ ...cur, ...removal.apply, ...removal.undo }).toEqual(cur);
    const snapshot = Object.fromEntries(Object.entries(cur).map(([key, value]) => [`indicator:${key}`, value]));
    expect(indicatorResetPatch('ichimoku', 'main', snapshot)).toMatchObject({ 'indicator:ichimokuEnabled': true, 'indicator:ichimokuHidden': true, 'indicator:ichimokuBasePeriod': 26, 'indicator:ichimokuCloudOpacity': .16, 'indicator:indicatorLineVisibility': { bollingerUpper: false } });
  });
  it('allows repeated OHLC overlays on calendar, minute, seconds and price-only instruments', () => {
    for (const tf of ['D', 'W', 'M', '1m', '3m', '1s', '10s'] as const)
      for (const priceOnly of [false, true]) expect(indicatorInstanceApplicable('ichimoku', tf, !priceOnly, priceOnly)).toBe(true);
  });
});
