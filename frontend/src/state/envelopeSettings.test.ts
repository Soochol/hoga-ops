import { beforeEach, describe, expect, it } from 'vitest';
import { useLivePageStore } from './livePage';
import { FACTORY_INDICATOR_SETTINGS, normalizeIndicatorsV2, resolveIndicatorSettings } from './indicatorSettingsV2';
import { flagRemovalPatches, INDICATOR_OPS } from './indicatorOps';

describe('Envelope settings', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorTimeframe: '1m' });
  });

  it('persists parameters in the current timeframe without enabling other timeframes', () => {
    useLivePageStore.getState().setEnvelopeEnabled(true);
    useLivePageStore.getState().setEnvelopeSettings({ envelopePeriod: 30, envelopePercent: 2.5, envelopeSource: 'hlc3' });
    const saved = normalizeIndicatorsV2(JSON.parse(localStorage.getItem('live.indicators.v2')!));
    expect(resolveIndicatorSettings(saved.byTimeframe, '1m')).toMatchObject({ envelopeEnabled: true, envelopePeriod: 30, envelopePercent: 2.5, envelopeSource: 'hlc3' });
    expect(resolveIndicatorSettings(saved.byTimeframe, 'D').envelopeEnabled).toBe(false);
  });

  it('normalizes old or corrupt storage and rejects invalid edits', () => {
    const saved = normalizeIndicatorsV2({ byTimeframe: { minute: { envelopeEnabled: true, envelopePeriod: 900, envelopePercent: -1, envelopeSource: 'invalid', envelopeUpperColor: 'invalid', envelopeLineWidth: 9 } } });
    expect(resolveIndicatorSettings(saved.byTimeframe, '1m')).toMatchObject({ envelopePeriod: 400, envelopePercent: 0.1, envelopeSource: 'close', envelopeUpperColor: '#3B82F6', envelopeLineWidth: 1 });
    expect(INDICATOR_OPS.setEnvelopeSettings(FACTORY_INDICATOR_SETTINGS, { envelopePeriod: NaN })).toBeNull();
    expect(INDICATOR_OPS.setEnvelopeSettings(FACTORY_INDICATOR_SETTINGS, { envelopePercent: Infinity })).toBeNull();
    expect(INDICATOR_OPS.setEnvelopeSettings(FACTORY_INDICATOR_SETTINGS, { envelopeUpperColor: 'invalid' })).toBeNull();
  });

  it('deletion resets the whole indicator and undo restores all parameters', () => {
    const cur = { ...FACTORY_INDICATOR_SETTINGS, envelopeEnabled: true, envelopeHidden: true, envelopePeriod: 55, envelopePercent: 3 };
    const patches = flagRemovalPatches(cur, 'envelope', FACTORY_INDICATOR_SETTINGS);
    expect({ ...cur, ...patches.apply }).toEqual(FACTORY_INDICATOR_SETTINGS);
    expect({ ...cur, ...patches.apply, ...patches.undo }).toEqual(cur);
    expect(INDICATOR_OPS.setEnvelopeEnabled(cur, true)).toEqual({ envelopeEnabled: true, envelopeHidden: false });
  });
});
