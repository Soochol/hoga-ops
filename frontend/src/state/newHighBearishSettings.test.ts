import { beforeEach, expect, it } from 'vitest';
import { FACTORY_INDICATOR_SETTINGS as factory, normalizeIndicatorsV2, resolveIndicatorSettings } from './indicatorSettingsV2';
import { flagRemovalPatches, INDICATOR_OPS } from './indicatorOps';
import { useLivePageStore } from './livePage';
import { captureIndicatorSettings, instanceSettings, makeIndicatorInstance } from './indicatorInstances';
import { DEFAULT_PREFS } from './chartPrefs';

beforeEach(() => { localStorage.clear(); useLivePageStore.setState({ ...factory, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: 'D' }); });
it('defaults to 200 trading days, 7%, one candle, and persists only the owning window/day bucket', () => {
  expect(factory).toMatchObject({ newHighBearishEnabled: false, newHighBearishLookback: 200, newHighBearishDropPct: 7, newHighBearishMaxCount: 1, newHighBearishMonths: 6 });
  const store = useLivePageStore.getState();
  store.patchIndicatorsScoped({ windowKey: 'live:new-high-a' }, 'D', { newHighBearishEnabled: true, newHighBearishLookback: 55, newHighBearishDropPct: 8.5, newHighBearishMaxCount: 2, newHighBearishMonths: 3 });
  const saved = normalizeIndicatorsV2(JSON.parse(localStorage.getItem('live.indicators.v2')!));
  expect(resolveIndicatorSettings(saved.byWindow['live:new-high-a'], 'D')).toMatchObject({ newHighBearishLookback: 55, newHighBearishDropPct: 8.5, newHighBearishMaxCount: 2, newHighBearishMonths: 3 });
  expect(resolveIndicatorSettings(saved.byWindow['live:new-high-b'] ?? {}, 'D').newHighBearishEnabled).toBe(false);
  expect(resolveIndicatorSettings(saved.byWindow['live:new-high-a'], '1m').newHighBearishEnabled).toBe(false);
});
it('rejects invalid edits, sanitizes persisted fields and isolates repeated instances', () => {
  for (const patch of [{ newHighBearishLookback: NaN }, { newHighBearishLookback: 0 }, { newHighBearishDropPct: -7 }, { newHighBearishDropPct: Infinity }, { newHighBearishColor: 'bad' }])
    expect(INDICATOR_OPS.setNewHighBearishSettings(factory, patch)).toBeNull();
  const saved = normalizeIndicatorsV2({ byTimeframe: { D: { newHighBearishLookback: 900, newHighBearishDropPct: -8, newHighBearishMaxCount: 7 } } });
  expect(resolveIndicatorSettings(saved.byTimeframe, 'D')).toMatchObject({ newHighBearishLookback: 400, newHighBearishDropPct: 0.1, newHighBearishMaxCount: 1 });
  const cur = { ...factory, newHighBearishEnabled: true, newHighBearishLookback: 50, newHighBearishMaxCount: 2 as const };
  const row = makeIndicatorInstance('new-high-bearish', cur, DEFAULT_PREFS);
  expect(instanceSettings(factory, row)).toMatchObject(cur);
  expect(Object.keys(captureIndicatorSettings('new-high-bearish', cur)).every(k => k.startsWith('newHighBearish'))).toBe(true);
  const { apply, undo } = flagRemovalPatches(cur, 'new-high-bearish', factory);
  expect({ ...cur, ...apply }).toEqual(factory);
  expect({ ...cur, ...apply, ...undo }).toEqual(cur);
});
