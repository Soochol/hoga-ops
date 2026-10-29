import { describe, expect, it } from 'vitest';
import { FACTORY_INDICATOR_SETTINGS as factory, INDICATOR_SETTING_KEYS, type IndicatorSettings } from '../../state/indicatorSettingsV2';
import { DEFAULT_PREFS } from '../../state/chartPrefs';
import { DEFAULT_CHART_DISPLAY_PREFS, VOLUME_OVERLAY_PREF_KEYS } from '../../state/chartDisplayPrefs';
import { instanceSettings, makeIndicatorInstance } from '../../state/indicatorInstances';
import { CATEGORIES } from './IndicatorPanelHelpers';
import { createCatalogDraft, indicatorIsPresent } from './indicatorCatalogDraft';
import { indicatorResetPatch } from './indicatorReset';
import type { SettingsSnapshot } from '../settings/useSettingsUndo';

function snapshot(settings: IndicatorSettings): SettingsSnapshot {
  return Object.fromEntries(INDICATOR_SETTING_KEYS.map(key => [`indicator:${key}`, settings[key]]));
}
function apply(settings: IndicatorSettings, patch: SettingsSnapshot): IndicatorSettings {
  return { ...settings, ...Object.fromEntries(Object.entries(patch).filter(([key]) => key.startsWith('indicator:')).map(([key, value]) => [key.slice(10), value])) };
}

describe('per-instance reset', () => {
  it.each(CATEGORIES)('$label keeps its primary membership, hide state, and sibling instances', category => {
    const active = createCatalogDraft(category.id, factory, DEFAULT_PREFS).store.getState().settings;
    const sibling = makeIndicatorInstance(category.id, active, DEFAULT_PREFS);
    const base = { ...active, indicatorPrimaryHidden: [category.id], indicatorInstances: [sibling] };
    const after = apply(base, indicatorResetPatch(category.id, 'main', snapshot(base)));
    expect(indicatorIsPresent(category.id, after)).toBe(true);
    expect(after.indicatorPrimaryHidden).toEqual([category.id]);
    expect(after.indicatorInstances).toBe(base.indicatorInstances);
  });
  it.each(CATEGORIES)('$label resets only the selected added instance and retains identity/visibility', category => {
    const active = createCatalogDraft(category.id, factory, DEFAULT_PREFS).store.getState().settings;
    const selected = { ...makeIndicatorInstance(category.id, active, DEFAULT_PREFS), hidden: true };
    const sibling = makeIndicatorInstance(category.id, active, DEFAULT_PREFS);
    const base = { ...factory, indicatorInstances: [selected, sibling] };
    const after = apply(base, indicatorResetPatch(category.id, selected.id, snapshot(base)));
    expect(after.indicatorInstances).toHaveLength(2);
    expect(after.indicatorInstances![0]).toMatchObject({ id: selected.id, category: category.id, hidden: true });
    expect(indicatorIsPresent(category.id, instanceSettings(after, after.indicatorInstances![0]))).toBe(true);
    expect(after.indicatorInstances![1]).toBe(sibling);
    expect(base.indicatorInstances[0]).toBe(selected);
  });
  it('restores the requested high-line defaults without switching it off or revealing it', () => {
    const base = { ...factory, newHighBearishEnabled: true, newHighBearishHidden: true,
      newHighBearishLookback: 50, newHighBearishDropPct: 10, newHighBearishMaxCount: 2 as const,
      newHighBearishMonths: 3, newHighBearishColor: '#123456', newHighBearishLineWidth: 4 as const, bollingerPeriod: 33 };
    const after = apply(base, indicatorResetPatch('new-high-bearish', 'main', snapshot(base)));
    expect(after).toMatchObject({ newHighBearishEnabled: true, newHighBearishHidden: true, newHighBearishLookback: 200,
      newHighBearishDropPct: 7, newHighBearishMaxCount: 1, newHighBearishMonths: 6,
      newHighBearishColor: '#F04452', newHighBearishLineWidth: 1, bollingerPeriod: 33 });
  });
  it('restores owned line switches and preference keys without changing other indicators', () => {
    const base = { ...factory, supertrendEnabled: true,
      indicatorLineVisibility: { supertrendUp: false as const, supertrendDown: false as const, bollingerLower: false as const } };
    const after = apply(base, indicatorResetPatch('supertrend', 'main', snapshot(base)));
    expect(after.indicatorLineVisibility).toEqual({ bollingerLower: false });
    const ratio = indicatorResetPatch('ratio', 'main', { ...snapshot({ ...factory, ratioEnabled: true }), 'pref:ratioOutlierFilterEnabled': !DEFAULT_PREFS.ratioOutlierFilterEnabled,
      'pref:quoteTotalsTickNormalize': !DEFAULT_PREFS.quoteTotalsTickNormalize });
    expect(ratio['pref:ratioOutlierFilterEnabled']).toBe(DEFAULT_PREFS.ratioOutlierFilterEnabled);
    expect('pref:quoteTotalsTickNormalize' in ratio).toBe(false);
  });
  it('resets primary volume placement, while added volume never changes window placement', () => {
    const base = { ...factory, volumeEnabled: true, volumeColorMode: 'previous-volume' as const };
    const before = { ...snapshot(base), ...Object.fromEntries(VOLUME_OVERLAY_PREF_KEYS.map(key => [`display:${key}`, 'changed'])) };
    const patch = indicatorResetPatch('volume', 'main', before);
    expect(patch['indicator:volumeEnabled']).toBe(true);
    expect(patch['indicator:volumeColorMode']).toBe('candle');
    for (const key of VOLUME_OVERLAY_PREF_KEYS) expect(patch[`display:${key}`]).toBe(DEFAULT_CHART_DISPLAY_PREFS[key]);
    const row = makeIndicatorInstance('volume', base, DEFAULT_PREFS);
    const added = indicatorResetPatch('volume', row.id, { ...before, 'indicator:indicatorInstances': [row] });
    expect(Object.keys(added)).toEqual(['indicator:indicatorInstances']);
    expect(indicatorResetPatch('volume', 'deleted', before)).toEqual({});
  });
});
