import { beforeEach, describe, expect, it } from 'vitest';
import { useLivePageStore } from './livePage';
import { FACTORY_INDICATOR_SETTINGS, normalizeIndicatorsV2, resolveIndicatorSettings } from './indicatorSettingsV2';
import { flagRemovalPatches, INDICATOR_OPS } from './indicatorOps';

describe('Bollinger settings', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorTimeframe: '1m' });
  });

  it('persists parameters in the current timeframe without enabling other timeframes', () => {
    useLivePageStore.getState().setBollingerEnabled(true);
    useLivePageStore.getState().setBollingerSettings({ bollingerPeriod: 30, bollingerMultiplier: 2.5, bollingerSource: 'hlc3' });
    const saved = normalizeIndicatorsV2(JSON.parse(localStorage.getItem('live.indicators.v2')!));
    expect(resolveIndicatorSettings(saved.byTimeframe, '1m')).toMatchObject({ bollingerEnabled: true, bollingerPeriod: 30, bollingerMultiplier: 2.5, bollingerSource: 'hlc3' });
    expect(resolveIndicatorSettings(saved.byTimeframe, 'D').bollingerEnabled).toBe(false);
  });

  it('normalizes old or corrupt storage and rejects invalid edits', () => {
    const saved = normalizeIndicatorsV2({ byTimeframe: { minute: { bollingerEnabled: true, bollingerPeriod: 900, bollingerMultiplier: -1, bollingerSource: 'invalid', bollingerUpperColor: 'invalid', bollingerLineWidth: 9 } } });
    expect(resolveIndicatorSettings(saved.byTimeframe, '1m')).toMatchObject({ bollingerPeriod: 400, bollingerMultiplier: 0.1, bollingerSource: 'close', bollingerUpperColor: '#3B82F6', bollingerLineWidth: 1 });
    expect(INDICATOR_OPS.setBollingerSettings(FACTORY_INDICATOR_SETTINGS, { bollingerPeriod: NaN })).toBeNull();
    expect(INDICATOR_OPS.setBollingerSettings(FACTORY_INDICATOR_SETTINGS, { bollingerMultiplier: Infinity })).toBeNull();
    expect(INDICATOR_OPS.setBollingerSettings(FACTORY_INDICATOR_SETTINGS, { bollingerUpperColor: 'invalid' })).toBeNull();
  });

  it('deletion resets the whole indicator and undo restores all parameters', () => {
    const cur = { ...FACTORY_INDICATOR_SETTINGS, bollingerEnabled: true, bollingerHidden: true, bollingerPeriod: 55, bollingerMultiplier: 3 };
    const patches = flagRemovalPatches(cur, 'bollinger', FACTORY_INDICATOR_SETTINGS);
    expect({ ...cur, ...patches.apply }).toEqual(FACTORY_INDICATOR_SETTINGS);
    expect({ ...cur, ...patches.apply, ...patches.undo }).toEqual(cur);
    expect(INDICATOR_OPS.setBollingerEnabled(cur, true)).toEqual({ bollingerEnabled: true, bollingerHidden: false });
  });
});
