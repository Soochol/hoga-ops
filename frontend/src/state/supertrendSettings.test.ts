import { beforeEach, describe, expect, it } from 'vitest';
import { useLivePageStore } from './livePage';
import { FACTORY_INDICATOR_SETTINGS, normalizeIndicatorsV2, resolveIndicatorSettings } from './indicatorSettingsV2';
import { flagRemovalPatches, INDICATOR_OPS } from './indicatorOps';

describe('Supertrend settings', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: '1m' });
  });

  it('persists parameters only in the active timeframe', () => {
    useLivePageStore.getState().setSupertrendEnabled(true);
    useLivePageStore.getState().setSupertrendSettings({ supertrendPeriod: 14, supertrendMultiplier: 2.5, supertrendUpColor: '#123456' });
    const saved = normalizeIndicatorsV2(JSON.parse(localStorage.getItem('live.indicators.v2')!));
    expect(resolveIndicatorSettings(saved.byTimeframe, '1m')).toMatchObject({ supertrendEnabled: true, supertrendPeriod: 14, supertrendMultiplier: 2.5, supertrendUpColor: '#123456' });
    expect(resolveIndicatorSettings(saved.byTimeframe, 'D').supertrendEnabled).toBe(false);
  });

  it('clamps corrupt persisted numbers and rejects invalid edits', () => {
    const saved = normalizeIndicatorsV2({ byTimeframe: { minute: { supertrendEnabled: true, supertrendPeriod: 900, supertrendMultiplier: -1, supertrendUpColor: 'invalid', supertrendLineWidth: 9 } } });
    expect(resolveIndicatorSettings(saved.byTimeframe, '1m')).toMatchObject({ supertrendPeriod: 400, supertrendMultiplier: 0.1, supertrendUpColor: '#F04452', supertrendLineWidth: 2 });
    for (const patch of [{ supertrendPeriod: NaN }, { supertrendMultiplier: Infinity }, { supertrendUpColor: 'invalid' }])
      expect(INDICATOR_OPS.setSupertrendSettings(FACTORY_INDICATOR_SETTINGS, patch)).toBeNull();
    expect(INDICATOR_OPS.setSupertrendSettings(FACTORY_INDICATOR_SETTINGS, { supertrendPeriod: 0 })).toEqual({ supertrendPeriod: 1 });
  });

  it('deletion resets all settings and undo restores them; adding clears hidden', () => {
    const cur = { ...FACTORY_INDICATOR_SETTINGS, supertrendEnabled: true, supertrendHidden: true, supertrendPeriod: 55, supertrendMultiplier: 2 };
    const patches = flagRemovalPatches(cur, 'supertrend', FACTORY_INDICATOR_SETTINGS);
    expect({ ...cur, ...patches.apply }).toEqual(FACTORY_INDICATOR_SETTINGS);
    expect({ ...cur, ...patches.apply, ...patches.undo }).toEqual(cur);
    expect(INDICATOR_OPS.setSupertrendEnabled(cur, true)).toEqual({ supertrendEnabled: true, supertrendHidden: false });
  });

  it('keeps two chart windows independent and persists their own timeframe buckets', () => {
    const s = useLivePageStore.getState();
    s.patchIndicatorsScoped({ windowKey: 'live:supertrend-a' }, 'D', { supertrendEnabled: true, supertrendPeriod: 7 });
    const saved = normalizeIndicatorsV2(JSON.parse(localStorage.getItem('live.indicators.v2')!));
    expect(resolveIndicatorSettings(saved.byWindow['live:supertrend-a'], 'D').supertrendPeriod).toBe(7);
    expect(resolveIndicatorSettings(saved.byWindow['live:supertrend-b'] ?? {}, 'D').supertrendEnabled).toBe(false);
    expect(resolveIndicatorSettings(saved.byWindow['live:supertrend-a'], '1m').supertrendEnabled).toBe(false);
  });
});
